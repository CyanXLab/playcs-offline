package cc.playcs.offline

import android.content.Context
import android.webkit.WebView

object WebViewVersion {
    fun get(ctx: Context): Int = try {
        val v = WebView.getCurrentWebViewPackage()?.versionName
            ?: android.webkit.WebSettings.getDefaultUserAgent(ctx)
                .substringAfter("Chrome/").substringBefore(" ").substringBefore(".")
        v.substringBefore('.').toIntOrNull() ?: 0
    } catch (_: Exception) { 0 }
}
