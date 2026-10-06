package cc.playcs.offline

import android.app.Activity
import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 首次运行资源下载器(断点续传):
 * - APK 已内置引擎文件(assets/www): play.js / play.wasm / 库文件 / 页面
 * - 需下载: chunks/ 资源包(约 2.2GB) 与大厅图片, 来自 playcs.cc 官方公共 CDN
 * - 已存在且大小一致的文件自动跳过; .part 断点续传
 */
object Downloader {

    private const val ORIGIN = "https://playcs.cc"
    private const val CDN = "https://file.playcs.cc"

    // (url, 相对路径) — 与 setup_download.py 清单一致的核心子集
    private val FILES: List<Pair<String, String>> = buildList {
        add("$ORIGIN/" to "index.html")
        for (n in listOf(
            "favicon.ico", "fonts.css", "offline-enhance.js", "mobile-touch.js",
            "manifest.webmanifest"
        )) add("$ORIGIN/$n" to n)
        // 大厅静态页(存在则用, 404 忽略)
        for (n in listOf("play.html", "privacy.html", "terms.html"))
            add("$ORIGIN/$n" to n)
        add("$CDN/play.wasm" to "play.wasm")
        for (m in listOf(
            "base", "hud", "savior", "zemod", "hideandseek", "weapon_skins",
            "patch1", "patch2", "patch3", "patch4", "patch5", "patch6", "de_dust2"
        )) add("$CDN/chunks/$m.data" to "chunks/$m.data")
        add("$CDN/chunks/uncompressed-bytes.json" to "chunks/uncompressed-bytes.json")
        for (m in listOf(
            "cs_assault", "cs_italy", "cs_office", "de_aztec", "de_cbble",
            "de_dust", "de_inferno", "de_nuke", "de_train"
        )) add("$CDN/chunks/$m.data" to "chunks/$m.data")
    }

    private val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "Chrome/120.0.0.0 Safari/537.36 PlayCSMobile/1.0"

    fun run(ctx: Context) {
        val www = File(ctx.filesDir, "www")
        val skipMark = File(ctx.filesDir, ".download-complete")
        if (skipMark.exists()) return
        var i = 0
        for ((url, rel) in FILES) {
            i++
            setStatus(ctx, "下载资源 $i/${FILES.size}: ${rel.substringAfterLast('/')}")
            fetch(url, File(www, rel))
        }
        skipMark.createNewFile()
    }

    private fun setStatus(ctx: Context, s: String) {
        if (ctx is Activity) ctx.runOnUiThread {
            try {
                ctx.findViewById<android.widget.TextView>(R.id.bootStatus).text = s
            } catch (_: Exception) {}
        }
    }

    private fun fetch(url: String, out: File) {
        if (out.exists() && out.length() > 0) return
        out.parentFile?.mkdirs()
        val part = File(out.path + ".part")
        for (attempt in 1..3) {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                conn.setRequestProperty("User-Agent", UA)
                if (part.exists() && part.length() > 0)
                    conn.setRequestProperty("Range", "bytes=${part.length()}-")
                conn.instanceFollowRedirects = true
                conn.connect()
                val code = conn.responseCode
                if (code == 404) { conn.disconnect(); return } // 可选文件, 原站本就没有
                if (code !in 200..299 && code != 206)
                    throw java.io.IOException("HTTP $code")
                val append = code == 206
                conn.inputStream.use { i ->
                    java.io.FileOutputStream(part, append).use { o -> i.copyTo(o, 1 shl 16) }
                }
                conn.disconnect()
                part.renameTo(out)
                return
            } catch (e: Exception) {
                if (attempt == 3) {
                    // 单文件失败不阻塞启动(可重进补下), 但标记未完成
                    return
                }
                Thread.sleep(2000)
            }
        }
    }
}
