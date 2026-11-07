package com.paperwork.mobile

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val pickFileRequest = 4102
    private val apiBase: String by lazy { getString(R.string.api_base_url).trimEnd('/') }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        if (apiBase.contains("YOUR-PAPER-WORK-SERVER")) {
            Toast.makeText(this, "Set your backend URL in app/src/main/res/values/strings.xml, then rebuild.", Toast.LENGTH_LONG).show()
            webView.loadData("<meta name='viewport' content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;padding:28px'><h2>Paper Work setup needed</h2><p>Set your deployed HTTPS backend URL in <b>strings.xml</b>, then build the APK again.</p></body>", "text/html", "UTF-8")
            return
        }
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        webView.settings.setSupportMultipleWindows(false)
        CookieManager.getInstance().setAcceptCookie(true)
        webView.addJavascriptInterface(PaperWorkBridge(this, apiBase), "PaperWorkBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                return if (url.scheme == "https" && (url.host == Uri.parse(apiBase).host)) false else {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "image/jpeg", "image/png", "image/webp", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
                }
                startActivityForResult(intent, pickFileRequest)
                return true
            }
        }
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val request = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("User-Agent", userAgent)
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "PaperWork-download")
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
        })
        webView.loadUrl(apiBase)
    }

    @Deprecated("Deprecated in Android")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == pickFileRequest) {
            val result = if (resultCode == Activity.RESULT_OK && data?.data != null) arrayOf(data.data!!) else null
            fileChooser?.onReceiveValue(result)
            fileChooser = null
        }
    }

    override fun onDestroy() { if (::webView.isInitialized) webView.destroy(); super.onDestroy() }
}

class PaperWorkBridge(private val context: Context, private val baseUrl: String) {
    @JavascriptInterface
    fun download(path: String, token: String, fileName: String) {
        try {
            val uri = Uri.parse(baseUrl + "/" + path.trimStart('/'))
            val request = DownloadManager.Request(uri)
                .addRequestHeader("Authorization", "Bearer $token")
                .setTitle(fileName)
                .setDescription("Downloading from Paper Work")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName.replace(Regex("[^A-Za-z0-9._-]"), "_"))
            (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
        } catch (e: Exception) {
            Toast.makeText(context, "Download could not be started: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}
