package cc.playcs.offline

import android.app.Activity
import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 首次运行资源下载器(断点续传):
 * - APK 已内置引擎文件(assets/www): play.js / play.wasm / 库文件 / 页面
 * - 需下载: 大厅样式/图片/模型/媒体 + lib*.so + chunks/ 资源包(约 2.2GB)
 * - 资源源可选:
 *     1) 默认: playcs.cc 官方公共 CDN
 *     2) 局域网 PC(推荐, 快): 运行 playcs_server.py 的电脑, 如 http://192.168.1.5:8000
 *        (默认静态端口 8000; 8787 是它的独立 API 备用口。PC 需放行防火墙入站 8000)
 *        指定后优先从 PC 拉取; 单文件失败自动回退官方 CDN; 地址存 SharedPreferences 记忆
 * - 清单与 PC 端 setup_download.py 完全一致; 已存在的文件自动跳过; .part 断点续传
 */
object Downloader {

    private const val ORIGIN = "https://playcs.cc"
    private const val CDN = "https://file.playcs.cc"
    private const val PREFS = "playcs_dl"
    private const val KEY_BASE = "custom_base"

    // (kind, 相对路径) — kind: "site"=playcs.cc 页面/资产, "cdn"=资源 CDN
    private val FILES: List<Pair<String, String>> = buildList {
        // 核心页面与引擎(引擎文件 assets 已内置, 下载时自动跳过, 仅兜底)
        add("site" to "index.html")
        add("site" to "play.html")
        add("site" to "play.js")
        add("cdn" to "play.wasm")

        // 大厅资产
        add("site" to "assets/app.js")
        add("site" to "assets/lobby.css")
        for (f in listOf(
            "hideandseek/hideandseek.css", "hideandseek/like.svg", "hideandseek/lock.svg",
            "hideandseek/star.svg", "killcards.css", "savior/savior.css",
            "sb/avatar-ct.png", "sb/avatar-terrorist.png", "dead.svg",
            "scoreboard.css", "winpanel.css"
        )) add("site" to "assets/hud/$f")

        // three.js
        add("site" to "vendor/three/three.module.min.js")
        add("site" to "vendor/three/addons/loaders/GLTFLoader.js")
        add("site" to "vendor/three/addons/utils/BufferGeometryUtils.js")

        // 图标 / 地图图标 / 媒体 / 模型 / 数据
        for (f in listOf("icon-32.png", "icon-128.png", "icon-512.png")) add("site" to f)
        for (f in listOf("cs_office", "de_aztec", "de_dust2", "de_mirage", "de_train", "dz_blacksite"))
            add("site" to "images/icon/map_icon_$f.png")
        for (f in listOf("aztec", "blacksite", "dust2", "mirage", "office", "train"))
            add("site" to "media/$f.webm")
        for (f in listOf("alchemy-fail", "alchemy-process", "alchemy-success", "openresult", "opensound"))
            add("site" to "media/$f.mp3") // 原站部分 404, 自动跳过
        for (f in listOf("ct_gign", "ct_gsg9", "ct_sas", "ct_urban", "t_arctic", "t_guerilla", "t_leet", "t_phoenix"))
            add("site" to "model/$f.glb")
        add("site" to "data/achievements-i18n.json")
        for (i in 1..40) {
            add("site" to "lobby/images/profile_rank/$i.png")
            add("site" to "images/profile_rank/$i.png")
        }

        // play.wasm 加载的动态库 lib*.so
        for (n in listOf(
            "libGameUI.so", "libServerBrowser.so", "libclient.so", "libdatacache.so",
            "libengine.so", "libfilesystem_stdio.so", "libinputsystem.so", "liblauncher.so",
            "libmaterialsystem.so", "libscenefilecache.so", "libserver.so", "libshaderapidx9.so",
            "libsoundemittersystem.so", "libstdshader_dx9.so", "libsteam_api.so",
            "libstudiorender.so", "libtogl.so", "libvaudio_minimp3.so", "libvgui2.so",
            "libvguimatsurface.so", "libvideo_services.so", "libvphysics.so", "libvstdlib.so",
            "libvtex_dll.so", "libvscript.so", "libschemadll.so", "libanimationsystem.so",
            "liblocalize.so"
        )) add("cdn" to n)

        // 分包(chunks)
        for (c in listOf(
            "base", "weapon_skins", "savior", "zemod", "hideandseek", "hud",
            "patch1", "patch2", "patch3", "patch4", "patch5", "patch6",
            "de_dust2", "de_dust", "de_inferno", "de_nuke", "de_aztec",
            "de_cbble", "de_train", "cs_office", "cs_italy", "cs_assault"
        )) add("cdn" to "chunks/$c.data")
        add("cdn" to "chunks/uncompressed-bytes.json")

        // 字体(自托管清单)
        add("site" to "fonts/fonts.css")
    }

    private val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "Chrome/120.0.0.0 Safari/537.36 PlayCSMobile/1.0"

    /** 读取用户上次设置的局域网资源源(如 http://192.168.1.5:8000), 末尾统一去斜杠 */
    fun getCustomBase(ctx: Context): String? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_BASE, null)?.trimEnd('/')

    /** 保存/清空(null)局域网资源源 */
    fun setCustomBase(ctx: Context, base: String?) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_BASE, base?.trimEnd('/')).apply()
    }

    fun run(ctx: Context) {
        val www = File(ctx.filesDir, "www")
        val skipMark = File(ctx.filesDir, ".download-complete-v2") // v2: 清单对齐 setup_download.py 后强制补齐
        if (skipMark.exists()) return
        val custom = getCustomBase(ctx)
        var i = 0
        for ((kind, rel) in FILES) {
            i++
            val shown = if (custom != null) "$custom → ${rel.substringAfterLast('/')}"
            else rel.substringAfterLast('/')
            setStatus(ctx, "下载资源 $i/${FILES.size}: $shown")
            val out = File(www, rel)
            // 优先用户指定源; 失败再试官方对应源(逐文件回退)
            if (custom != null) {
                val ok = fetch("$custom/$rel", out, retries = 2)
                if (!ok && kind == "site") fetch("$ORIGIN/$rel", out, retries = 2)
                if (!ok && kind == "cdn") fetch("$CDN/$rel", out, retries = 2)
            } else {
                fetch(if (kind == "site") "$ORIGIN/$rel" else "$CDN/$rel", out)
            }
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

    /** @return true=文件就绪(新下或已存在), false=尝试失败(不阻塞启动, 重进可补) */
    private fun fetch(url: String, out: File, retries: Int = 3): Boolean {
        if (out.exists() && out.length() > 0) return true
        out.parentFile?.mkdirs()
        val part = File(out.path + ".part")
        for (attempt in 1..retries) {
            var conn: HttpURLConnection? = null
            try {
                conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                conn.setRequestProperty("User-Agent", UA)
                if (part.exists() && part.length() > 0)
                    conn.setRequestProperty("Range", "bytes=${part.length()}-")
                conn.instanceFollowRedirects = true
                conn.connect()
                val code = conn.responseCode
                if (code == 404) return false // 可选文件(如部分 mp3), 原站本就没有
                if (code !in 200..299 && code != 206)
                    throw java.io.IOException("HTTP $code")
                val append = code == 206
                conn.inputStream.use { i ->
                    java.io.FileOutputStream(part, append).use { o -> i.copyTo(o, 1 shl 16) }
                }
                part.renameTo(out)
                return true
            } catch (e: Exception) {
                if (attempt == retries) return false
                Thread.sleep(2000)
            } finally {
                conn?.disconnect()
            }
        }
        return false
    }
}
