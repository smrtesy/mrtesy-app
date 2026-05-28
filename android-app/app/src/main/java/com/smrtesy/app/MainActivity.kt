package com.smrtesy.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.View
import android.webkit.*
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.smrtesy.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        const val APP_URL = "https://app.smrtesy.com"

        // URLs שייפתחו ב-browser חיצוני / אפליקציה native
        private val EXTERNAL_HOSTS = setOf(
            "mail.google.com",
            "drive.google.com",
            "docs.google.com",
            "sheets.google.com",
            "slides.google.com",
            "calendar.google.com",
            "claude.ai",
            "chat.openai.com",
            "accounts.google.com",
        )
    }

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val uris = result.data?.let { data ->
                data.clipData?.let { clip ->
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                } ?: data.data?.let { arrayOf(it) }
            } ?: emptyArray()
            filePathCallback?.onReceiveValue(uris)
        } else {
            filePathCallback?.onReceiveValue(null)
        }
        filePathCallback = null
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* אין צורך לעשות כלום — FCM יעבוד בכל מקרה */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWebView()
        setupSwipeRefresh()
        requestNotificationPermission()

        // טיפול ב-deep link אם האפליקציה נפתחה מלינק
        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val url = intent?.getStringExtra("navigate_url")
            ?: intent?.data?.toString()
        if (!url.isNullOrEmpty() && url.startsWith(APP_URL)) {
            binding.webView.loadUrl(url)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        binding.webView.apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                setSupportMultipleWindows(true)
                javaScriptCanOpenWindowsAutomatically = true
                // Remove "wv" WebView marker so the site treats us like Chrome Mobile
                userAgentString = "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            }

            webViewClient = SmrtesyWebViewClient()
            webChromeClient = SmrtesyWebChromeClient()

            loadUrl(APP_URL)
        }
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefresh.apply {
            setColorSchemeResources(R.color.primary)
            setOnRefreshListener {
                binding.webView.reload()
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this, Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onBackPressed() {
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    // ── WebViewClient ──────────────────────────────────────────────────────────

    inner class SmrtesyWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(
            view: WebView, request: WebResourceRequest
        ): Boolean {
            val url = request.url ?: return false
            val host = url.host ?: return false

            // פתח ב-app native / browser חיצוני
            if (EXTERNAL_HOSTS.any { host.endsWith(it) }) {
                openExternal(url)
                return true
            }

            // כל שאר הURLים בתוך app.smrtesy.com — נשארים ב-WebView
            if (host == Uri.parse(APP_URL).host) {
                return false
            }

            // כל שאר ה-links — דפדפן חיצוני
            openExternal(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            binding.progressBar.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String) {
            binding.progressBar.visibility = View.GONE
            binding.swipeRefresh.isRefreshing = false
        }

        override fun onReceivedError(
            view: WebView, request: WebResourceRequest, error: WebResourceError
        ) {
            if (request.isForMainFrame) {
                view.loadUrl("about:blank")
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.error_no_connection),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    // ── WebChromeClient ────────────────────────────────────────────────────────

    inner class SmrtesyWebChromeClient : WebChromeClient() {

        override fun onShowFileChooser(
            view: WebView,
            filePathCb: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = filePathCb

            val intent = params.createIntent()
            filePickerLauncher.launch(intent)
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.grant(request.resources)
        }

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            binding.progressBar.progress = newProgress
        }

        // תמיכה בפתיחת חלון חדש (window.open)
        override fun onCreateWindow(
            view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message
        ): Boolean {
            val newWebView = WebView(this@MainActivity)
            newWebView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                    openExternal(req.url)
                    return true
                }
            }
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = newWebView
            resultMsg.sendToTarget()
            return true
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, getString(R.string.error_open_link), Toast.LENGTH_SHORT).show()
        }
    }
}
