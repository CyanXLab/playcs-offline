package cc.playcs.offline

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import fi.iki.elonen.NanoHTTPD

/**
 * 内置本地服务器:
 * - 静态文件(www/) + 必需的 COOP/COEP 响应头(引擎 SharedArrayBuffer 硬要求)
 * - /api/ 接口桩: 离线模式最小应答, 保证大厅/引擎不因缺接口报错
 * - 联机中继: 手机端无需 WS↔UDP 桥(引擎本身走 WebSocket), 在 F8 设置里
 *   把中继指向局域网 PC 上的 playcs_server.py / PlayCS.exe --serve-only 即可
 */
object WwwServer {

    private var server: Nano? = null
    private lateinit var www: File
    const val DEFAULT_PORT = 8787

    fun pickPort(): Int = DEFAULT_PORT // NanoHTTPD 冲突时由 Nano 内部尝试顺延

    fun ensureAssets(ctx: Context) {
        www = File(ctx.filesDir, "www").also { it.mkdirs() }
        // APK assets/www/** → filesDir/www/** (幂等: 以 .installed 标记)
        val mark = File(www, ".installed-v1")
        if (mark.exists()) return
        val am = ctx.assets
        fun copyDir(rel: String) {
            val list = am.list("www" + if (rel.isEmpty()) "" else "/$rel") ?: return
            if (list.isEmpty()) {
                val out = File(www, rel)
                out.parentFile?.mkdirs()
                am.open("www/$rel").use { i -> out.outputStream().use { i.copyTo(it) } }
                return
            }
            for (name in list) copyDir(if (rel.isEmpty()) name else "$rel/$name")
        }
        copyDir("")
        mark.createNewFile()
    }

    fun start(port: Int) {
        if (server != null) return
        server = Nano(port, www).also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true) }
    }

    fun stop() {
        server?.stop(); server = null
    }

    fun intercept(url: android.net.Uri): WebResourceResponse? = null // 预留: 屏蔽统计域名等

    private class Nano(port: Int, private val www: File) : NanoHTTPD(port) {

        override fun serve(session: IHTTPSession): Response {
            var path = session.uri.trimStart('/')
            if (path.isEmpty()) path = "index.html"

            // ---- API 桩 ----
            if (path.startsWith("api/")) return apiStub(path)

            // ---- 静态文件 ----
            val f = File(www, path).normalize()
            if (!f.path.startsWith(www.path)) return notFound()
            if (!f.exists() || f.isDirectory) {
                val idx = File(f, "index.html")
                if (idx.exists()) return static(idx) else return notFound()
            }
            return static(f)
        }

        private fun static(f: File): Response {
            val mime = mimeOf(f.name)
            return newChunkedResponse(Response.Status.OK, mime, FileInputStream(f))
                .apply { addSecurityHeaders() }
        }

        private fun apiStub(path: String): Response {
            val json = when {
                path.startsWith("api/servers") ->
                    """{"success":true,"data":[]}"""
                path.contains("auth") || path.contains("login") || path.contains("session") ->
                    """{"success":true,"data":{"accessToken":"offline-local","displayName":"Mobile"}}"""
                else -> """{"success":true,"data":[]}"""
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json", json)
                .apply { addSecurityHeaders() }
        }

        private fun Response.addSecurityHeaders(): Response {
            addHeader("Cross-Origin-Opener-Policy", "same-origin")
            addHeader("Cross-Origin-Embedder-Policy", "require-corp")
            addHeader("Cross-Origin-Resource-Policy", "cross-origin")
            addHeader("Access-Control-Allow-Origin", "*")
            addHeader("Cache-Control", "no-cache")
            return this
        }

        private fun mimeOf(name: String): String {
            val e = name.substringAfterLast('.', "").lowercase()
            return when (e) {
                "html", "htm" -> "text/html; charset=utf-8"
                "js" -> "application/javascript; charset=utf-8"
                "css" -> "text/css; charset=utf-8"
                "json", "data" -> "application/json; charset=utf-8"
                "wasm" -> "application/wasm"
                "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "svg" -> "image/svg+xml"
                "glb", "gltf" -> "model/gltf-binary"
                "webm" -> "video/webm"; "mp3" -> "audio/mpeg"
                "so" -> "application/octet-stream"
                else -> "application/octet-stream"
            }
        }

        private fun notFound() = newFixedLengthResponse(
            Response.Status.NOT_FOUND, "text/plain", "404 (mobile local server)")
    }
}
