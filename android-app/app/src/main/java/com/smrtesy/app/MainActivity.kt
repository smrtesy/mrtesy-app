package com.smrtesy.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Message
import android.util.Log
import android.view.View
import android.webkit.*
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.smrtesy.app.databinding.ActivityMainBinding
import android.os.Bundle

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val debugLines = mutableListOf<String>()

    companion object {
        const val APP_URL = "https://app.smrtesy.com"
        private const val TAG = "SmrtesyWebView"

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
    ) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Enable Chrome DevTools inspection (works over USB via chrome://inspect).
        // Debug builds only — release builds must not expose the WebView to
        // remote inspection.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setupWebView()
        setupSwipeRefresh()
        requestNotificationPermission()
        handleDeepLink(intent)

        // Tap debug overlay to dismiss
        binding.debugOverlay.setOnClickListener { hideDebug() }
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
                userAgentString = "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            }

            // JavaScript bridge for console capturing
            addJavascriptInterface(ConsoleCapture(), "AndroidDebug")

            webViewClient = SmrtesyWebViewClient()
            webChromeClient = SmrtesyWebChromeClient()

            loadUrl(APP_URL)
        }
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefresh.apply {
            setColorSchemeResources(R.color.primary)
            setOnRefreshListener {
                hideDebug()
                binding.webView.reload()
            }
            // Only own the pull-down gesture when the WebView is scrolled to the
            // very top. Otherwise report "the child can scroll up" so the drag
            // scrolls the page instead of firing a refresh. The default check
            // inspects the direct child's scroll offset, which was wrong while a
            // wrapper sat between the layout and the WebView; keying off the
            // WebView's real scrollY makes top-detection correct.
            setOnChildScrollUpCallback { _, _ -> binding.webView.scrollY > 0 }
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

    private fun logDebug(line: String) {
        Log.d(TAG, line)
        debugLines.add(line)
        runOnUiThread {
            binding.debugText.text = debugLines.joinToString("\n")
            binding.debugOverlay.visibility = View.VISIBLE
        }
    }

    private fun hideDebug() {
        binding.debugOverlay.visibility = View.GONE
    }

    override fun onBackPressed() {
        when {
            binding.debugOverlay.visibility == View.VISIBLE -> hideDebug()
            binding.webView.canGoBack() -> binding.webView.goBack()
            else -> super.onBackPressed()
        }
    }

    // ── JavaScript bridge ──────────────────────────────────────────────────────

    inner class ConsoleCapture {
        @JavascriptInterface
        fun log(msg: String) = logDebug("[JS:log] $msg")

        @JavascriptInterface
        fun error(msg: String) = logDebug("[JS:error] $msg")

        @JavascriptInterface
        fun warn(msg: String) = logDebug("[JS:warn] $msg")
    }

    // ── WebViewClient ──────────────────────────────────────────────────────────

    inner class SmrtesyWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(
            view: WebView, request: WebResourceRequest
        ): Boolean {
            val url = request.url ?: return false
            val host = url.host ?: return false
            logDebug("[nav] $url")

            if (EXTERNAL_HOSTS.any { host.endsWith(it) }) {
                openExternal(url)
                return true
            }
            if (host == Uri.parse(APP_URL).host) return false
            openExternal(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            logDebug("[load] started: $url")
            binding.progressBar.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String) {
            logDebug("[load] finished: $url")
            binding.progressBar.visibility = View.GONE
            binding.swipeRefresh.isRefreshing = false

            view.evaluateJavascript("""
                (function() {
                    // Console capture
                    var orig = { log: console.log, error: console.error, warn: console.warn };
                    console.log   = function(m) { AndroidDebug.log(String(m));   orig.log.apply(console, arguments); };
                    console.error = function(m) { AndroidDebug.error(String(m)); orig.error.apply(console, arguments); };
                    console.warn  = function(m) { AndroidDebug.warn(String(m));  orig.warn.apply(console, arguments); };
                    window.onerror = function(msg, src, line, col, err) {
                        AndroidDebug.error('UNCAUGHT: ' + msg + ' @ ' + src + ':' + line);
                    };
                    window.onunhandledrejection = function(e) {
                        AndroidDebug.error('PROMISE: ' + (e.reason || e));
                    };

                    // DOM snapshot
                    AndroidDebug.log('TITLE: ' + document.title);
                    AndroidDebug.log('BODY_CHILDREN: ' + document.body.children.length);
                    AndroidDebug.log('BODY_TEXT: ' + (document.body.innerText || '').substring(0, 200));
                    AndroidDebug.log('COOKIES: ' + (document.cookie ? document.cookie.substring(0, 100) : 'none'));
                    AndroidDebug.log('SCRIPTS: ' + document.scripts.length);
                    var meta = document.querySelector('meta[name="viewport"]');
                    AndroidDebug.log('VIEWPORT: ' + (meta ? meta.content : 'missing'));
                })();
            """.trimIndent(), null)
        }

        override fun onReceivedError(
            view: WebView, request: WebResourceRequest, error: WebResourceError
        ) {
            val tag = if (request.isForMainFrame) "[NET ERROR:MAIN]" else "[NET ERROR:sub]"
            logDebug("$tag code=${error.errorCode} ${error.description}\n  url=${request.url}")
        }

        override fun onReceivedHttpError(
            view: WebView, request: WebResourceRequest, response: WebResourceResponse
        ) {
            val tag = if (request.isForMainFrame) "[HTTP ERROR:MAIN]" else "[HTTP ERROR:sub]"
            logDebug("$tag ${response.statusCode}\n  url=${request.url}")
        }
    }

    // ── WebChromeClient ────────────────────────────────────────────────────────

    inner class SmrtesyWebChromeClient : WebChromeClient() {

        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
            logDebug("[console:${msg.messageLevel()}] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
            return true
        }

        override fun onShowFileChooser(
            view: WebView,
            filePathCb: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = filePathCb
            filePickerLauncher.launch(params.createIntent())
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.grant(request.resources)
        }

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            binding.progressBar.progress = newProgress
        }

        override fun onCreateWindow(
            view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message
        ): Boolean {
            val newWebView = WebView(this@MainActivity)
            newWebView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                    logDebug("[popup] opening: ${req.url}")
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
        logDebug("[external] opening: $uri")
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, getString(R.string.error_open_link), Toast.LENGTH_SHORT).show()
        }
    }
}
