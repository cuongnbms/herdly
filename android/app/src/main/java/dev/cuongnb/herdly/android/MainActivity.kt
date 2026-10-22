package dev.cuongnb.herdly.android

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** A full-screen WebView on Herdly Web. The pairing cookie lives in the WebView's own cookie jar. */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var errorDialog: AlertDialog? = null

    private val prefs by lazy { getSharedPreferences("herdly", MODE_PRIVATE) }

    /** Scheme, host and port of the Herdly Web this app was last pointed at. */
    private var origin: String?
        get() = prefs.getString(KEY_ORIGIN, null)
        set(value) = prefs.edit().putString(KEY_ORIGIN, value).apply()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            setBackgroundColor(BACKGROUND)
            settings.javaScriptEnabled = true
            // drafts.ts and seen.ts keep their state in localStorage.
            settings.domStorageEnabled = true
            webViewClient = Client()
            // Without a WebChromeClient, alert() and confirm() are dropped.
            webChromeClient = WebChromeClient()
        }
        CookieManager.getInstance().setAcceptCookie(true)

        // targetSdk 35 draws edge to edge: keep the page clear of the bars, the cutout and the keyboard.
        val root = FrameLayout(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(web)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val pad = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(pad.left, pad.top, pad.right, pad.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this) {
            // Pane navigation is React state, not WebView history. A cancelled event means
            // the page handled Back; old servers and the root screen keep the native fallback.
            web.evaluateJavascript(
                "window.dispatchEvent(new Event('herdly:android-back', { cancelable: true }))",
            ) { unhandled ->
                if (unhandled != "false") {
                    if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                }
            }
        }

        route(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        route(intent)
    }

    override fun onPause() {
        super.onPause()
        // Persist a cookie set by /pair even if the process is killed right after.
        CookieManager.getInstance().flush()
    }

    private fun route(intent: Intent) {
        val o = origin
        // Load first, so cancelling the pairing dialog from the shortcut leaves the page behind it.
        if (o != null && web.url == null) web.loadUrl("$o/")
        if (o == null || intent.action == ACTION_PAIR) askForLink()
    }

    private fun askForLink() {
        val input = EditText(this).apply {
            setHint(R.string.pair_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        val box = FrameLayout(this).apply {
            val side = (20 * resources.displayMetrics.density).toInt()
            setPadding(side, 0, side, 0)
            addView(input)
        }
        val firstRun = origin == null
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.pair_title)
            .setMessage(R.string.pair_message)
            .setView(box)
            .setCancelable(!firstRun)
            .setPositiveButton(R.string.pair_open, null)
            .setNegativeButton(R.string.cancel) { _, _ -> if (firstRun) finish() }
            .create()
        dialog.setOnShowListener {
            // Set here, not in the builder, so an invalid link keeps the dialog open.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val link = parseServerLink(input.text.toString())
                if (link == null) {
                    input.error = getString(R.string.pair_invalid)
                } else {
                    origin = link.origin
                    dialog.dismiss()
                    web.loadUrl(link.url)
                }
            }
        }
        dialog.show()
    }

    private fun showError(url: String, description: CharSequence) {
        errorDialog?.dismiss()
        errorDialog = AlertDialog.Builder(this)
            .setTitle(R.string.error_title)
            .setMessage("$url\n\n$description")
            .setCancelable(false)
            .setPositiveButton(R.string.error_retry) { _, _ -> web.reload() }
            .setNegativeButton(R.string.error_change) { _, _ -> askForLink() }
            .show()
    }

    private inner class Client : WebViewClient() {
        /** Herdly Web stays in the app; any other link opens in the browser. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val o = origin
            if (o != null && isSameOrigin(request.url.toString(), o)) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (_: ActivityNotFoundException) {
                // Nothing handles it; drop the click.
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError(request.url.toString(), error.description)
        }
    }

    private companion object {
        const val KEY_ORIGIN = "origin"
        const val ACTION_PAIR = "dev.cuongnb.herdly.android.PAIR"
        const val BACKGROUND = 0xFF1A1B1F.toInt()
    }
}
