package cc.playcs.offline

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File

/**
 * PlayCS Offline — Android WebView 壳
 * - 内置本地服务器(WwwServer): 静态文件 + COOP/COEP 头(SharedArrayBuffer 硬要求) + API 桩
 * - 首次运行解压 APK 内置引擎文件, 下载 chunks 资源包(约 2.2GB, 断点续传)
 * - 渲染进程崩溃自动恢复 / 全局异常兜底 / 内存告警通知 JS 层
 */
class MainActivity : Activity() {

    private var webView: WebView? = null
    private val main = Handler(Looper.getMainLooper())
    private var port = 8787

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.boot)
        goImmersive(window.decorView)

        Thread.setDefaultUncaughtExceptionHandler { _, _ ->
            try { File(filesDir, "crash.flag").createNewFile() } catch (_: Exception) {}
        }

        // WebView 版本检查: COOP/COEP + SharedArrayBuffer 需要 Chromium 92+
        val wvVersion = WebViewVersion.get(this)
        if (wvVersion < 92) {
            AlertDialog.Builder(this)
                .setTitle("WebView 版本过低")
                .setMessage("当前 WebView 主版本: $wvVersion\n本游戏需要 Chromium 92+。\n请到应用商店更新『Android System WebView』后重试。\n\n仍要继续尝试吗?")
                .setPositiveButton("继续") { _, _ -> startGame() }
                .setNegativeButton("退出") { _, _ -> finish() }
                .setCancelable(false)
                .show()
            return
        }
        startGame()
    }

    private fun startGame() {
        Thread {
            try {
                port = WwwServer.pickPort()
                WwwServer.ensureAssets(this)
                Downloader.run(this)
                WwwServer.start(port)
                main.post { initWebView() }
            } catch (t: Throwable) {
                main.post { fatal(t) }
            }
        }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWebView() {
        val wv = WebView(this)
        wv.setBackgroundColor(0xFF0B0E14.toInt())
        val w = wv.settings
        w.javaScriptEnabled = true
        w.domStorageEnabled = true
        w.databaseEnabled = true
        w.mediaPlaybackRequiresUserGesture = false
        w.cacheMode = WebSettings.LOAD_DEFAULT
        w.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        w.userAgentString = w.userAgentString + " PlayCSMobile/1.0"
        CookieManager.getInstance().setAcceptCookie(true)

        wv.webChromeClient = WebChromeClient()
        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? = WwwServer.intercept(request!!.url)

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                // 渲染进程崩溃(多由 GPU/OOM 引起): 销毁重建, 自动恢复, 不闪退
                (view?.parent as? android.view.ViewGroup)?.removeView(view)
                view?.destroy()
                main.post {
                    android.widget.Toast.makeText(
                        this@MainActivity, "渲染进程已崩溃, 正在自动恢复…",
                        android.widget.Toast.LENGTH_LONG
                    ).show()
                    initWebView()
                }
                return true
            }
        }
        setContentView(wv)
        goImmersive(wv)
        webView = wv
        wv.loadUrl("http://127.0.0.1:$port/")
    }

    private fun fatal(t: Throwable) {
        AlertDialog.Builder(this)
            .setTitle("启动失败")
            .setMessage("${t.message}\n\n请检查网络(首次运行需下载约 2.2GB 资源包)后重试。")
            .setPositiveButton("重试") { _, _ -> recreate() }
            .setNegativeButton("退出") { _, _ -> finish() }
            .show()
    }

    private fun goImmersive(v: View) {
        v.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            val v = (webView as? View) ?: window.decorView
            goImmersive(v)
        }
    }

    override fun onDestroy() {
        WwwServer.stop()
        super.onDestroy()
    }

    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else super.onBackPressed()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new Event('android-lowmem'));", null)
        }
    }
}
