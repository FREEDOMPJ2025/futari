package dev.southernlight.futari;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.ArrayDeque;

/**
 * Load watchdog for the thin shell (#1672).
 *
 * <p>Capacitor has no load timeout. On a stalled network the WebView sits on a blank background
 * for 10-25 s before {@code errorPath} (offline.html) appears. This client arms a timer when a
 * network main-frame load toward the server origin starts, disarms it when a server-origin
 * document commits, and on expiry stops the load and navigates to the bundled offline page exactly
 * once. The offline page returns to the app by itself (scripts/build-native-offline-page.ts).
 *
 * <p>The rules (timeouts 6 -> 15 -> 30 s then stays at 30 s, never disabled; reset only after a
 * server document was shown 60 s with no fire, or after > 5 min in the background) are mirrored
 * from scripts/native-offline-logic.ts, which has the unit tests. Change both together.
 *
 * <p>Failure looks like: nothing. A watchdog that never arms leaves the old blank screen; one that
 * fires on a normal load flashes the offline page. Look at {@code adb logcat -s FutariWatchdog}.
 *
 * <p>Every override calls {@code super} and returns its result unchanged. All state is touched on
 * the main thread; {@link #shouldInterceptRequest} runs on a WebView IO thread, so it only posts.
 */
public class FutariWebViewClient extends BridgeWebViewClient {
    static final String TAG = "FutariWatchdog";

    // Mirror of watchdogTimeoutMs() and friends in scripts/native-offline-logic.ts.
    static final long[] TIMEOUTS_MS = {6000, 15000, 30000};
    static final long RESET_AFTER_SHOWN_MS = 60_000;
    static final long RESET_AFTER_BACKGROUND_MS = 5 * 60_000;
    /** How long to wait for Capacitor / the WebView to start the error page before doing it. */
    static final long ERROR_NAV_GRACE_MS = 500;
    private static final int SUPERSEDED_MAX = 8;

    private final Bridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---- main thread only ----
    private int gen = 0;
    private boolean armed = false;
    private String expectedUrl = null;
    private final ArrayDeque<String> superseded = new ArrayDeque<>();
    private long armAt = 0;
    private Runnable fireRunnable = null;
    private Runnable resetRunnable = null;
    private int consecutiveFires = 0;
    private long backgroundedAt = 0;
    // counters (acceptance reads these from the log)
    private int fireCount = 0;
    private int errorNavCount = 0;
    // set from the IO thread too
    private volatile boolean errorNavSeen = false;
    private boolean finishedSinceArm = false;

    public FutariWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    /** Install on the bridge. Call right after super.onCreate(): the swap lands before the first main-frame request. */
    public static FutariWebViewClient install(Bridge bridge) {
        FutariWebViewClient client = new FutariWebViewClient(bridge);
        bridge.setWebViewClient(client);
        // A main-frame response that turns into a download never commits; do not time it out.
        // Capacitor sets no DownloadListener, so this does not change behaviour.
        bridge.getWebView().setDownloadListener((url, ua, cd, mime, len) -> client.main.post(() -> client.disarm("download")));
        return client;
    }

    // ---------------------------------------------------------------- helpers

    private static long timeoutFor(int consecutiveFires) {
        return TIMEOUTS_MS[Math.min(Math.max(consecutiveFires, 0), TIMEOUTS_MS.length - 1)];
    }

    private static String stripFragment(String url) {
        if (url == null) return "";
        int i = url.indexOf('#');
        return i >= 0 ? url.substring(0, i) : url;
    }

    /** Log shape only (first path segment): URLs can carry share tokens. */
    private static String shape(String url) {
        try {
            String p = Uri.parse(url).getPath();
            if (p == null || p.length() <= 1) return "/";
            int i = p.indexOf('/', 1);
            return i < 0 ? p : p.substring(0, i) + "/*";
        } catch (Exception e) {
            return "?";
        }
    }

    private boolean isServerOrigin(Uri u) {
        try {
            Uri s = Uri.parse(bridge.getServerUrl());
            return u != null
                && u.getScheme() != null && u.getScheme().equals(s.getScheme())
                && u.getHost() != null && u.getHost().equals(s.getHost())
                && u.getPort() == s.getPort();
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isErrorUrl(String url) {
        String e = bridge.getErrorUrl();
        return e != null && url != null && stripFragment(url).startsWith(stripFragment(e));
    }

    // ---------------------------------------------------------------- lifecycle (MainActivity)

    public void onBackgrounded() {
        backgroundedAt = SystemClock.elapsedRealtime();
    }

    public void onForegrounded() {
        if (backgroundedAt > 0 && SystemClock.elapsedRealtime() - backgroundedAt > RESET_AFTER_BACKGROUND_MS) {
            if (consecutiveFires != 0) Log.i(TAG, "escalation reset (background > 5 min)");
            consecutiveFires = 0;
        }
        backgroundedAt = 0;
    }

    // ---------------------------------------------------------------- arm / disarm / fire

    /** Main thread. */
    private void arm(String url) {
        if (armed && expectedUrl != null && !expectedUrl.equals(url)) {
            superseded.remove(expectedUrl);
            superseded.addLast(expectedUrl);
            while (superseded.size() > SUPERSEDED_MAX) superseded.removeFirst();
        }
        superseded.remove(url);
        cancel(fireRunnable);
        cancel(resetRunnable);
        gen++;
        armed = true;
        expectedUrl = url;
        finishedSinceArm = false;
        armAt = SystemClock.elapsedRealtime();
        final int g = gen;
        final long timeout = timeoutFor(consecutiveFires);
        fireRunnable = () -> fire(g, timeout);
        main.postDelayed(fireRunnable, timeout);
        Log.i(TAG, "arm gen=" + g + " timeout=" + timeout + "ms consecutive=" + consecutiveFires + " " + shape(url));
    }

    private void disarm(String why) {
        if (!armed) return;
        armed = false;
        cancel(fireRunnable);
        Log.i(TAG, "disarm gen=" + gen + " (" + why + ") after " + (SystemClock.elapsedRealtime() - armAt) + "ms");
    }

    private void cancel(Runnable r) {
        if (r != null) main.removeCallbacks(r);
    }

    private void fire(int g, long timeout) {
        if (g != gen || !armed) return;
        armed = false;
        final WebView view = bridge.getWebView();
        if (view == null) return;
        int progress = view.getProgress();
        // Pending guard: only act while the armed load is still in flight.
        if (finishedSinceArm || progress >= 100) {
            Log.i(TAG, "fire skipped gen=" + g + " not pending (finished=" + finishedSinceArm + " progress=" + progress + ")");
            return;
        }
        consecutiveFires++;
        fireCount++;
        errorNavSeen = false;
        cancel(resetRunnable);
        Log.i(TAG, "FIRE gen=" + g + " after " + timeout + "ms progress=" + progress
            + " fires=" + fireCount + " errorNavs=" + errorNavCount + " nextTimeout=" + timeoutFor(consecutiveFires) + "ms");
        view.stopLoading();
        main.postDelayed(() -> {
            // Exactly one error navigation: only if nothing started it, and nothing newer began.
            if (errorNavSeen || g != gen || armed) {
                Log.i(TAG, "error page started by itself (fallback not needed) errorNavs=" + errorNavCount);
                return;
            }
            String err = bridge.getErrorUrl();
            if (err == null) return;
            errorNavSeen = true;
            Log.i(TAG, "fallback loadUrl(errorUrl) after " + ERROR_NAV_GRACE_MS + "ms");
            view.loadUrl(err);
        }, ERROR_NAV_GRACE_MS);
    }

    /** A server-origin document is on screen: after 60 s with no fire, the escalation resets. */
    private void startShownTimer() {
        cancel(resetRunnable);
        resetRunnable = () -> {
            if (consecutiveFires != 0) Log.i(TAG, "escalation reset (shown 60 s, no fire)");
            consecutiveFires = 0;
        };
        main.postDelayed(resetRunnable, RESET_AFTER_SHOWN_MS);
    }

    // ---------------------------------------------------------------- WebViewClient

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request.isForMainFrame()) {
            Uri uri = request.getUrl();
            String url = stripFragment(uri.toString());
            if (isErrorUrl(url)) {
                errorNavSeen = true;
            } else if ("GET".equals(request.getMethod()) && isServerOrigin(uri)) {
                // Arm BEFORE super: it may block this thread. Posting keeps state on the main thread.
                main.post(() -> arm(url));
            }
        }
        return super.shouldInterceptRequest(view, request);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        boolean handled = super.shouldOverrideUrlLoading(view, request);
        if (request.isForMainFrame()) {
            if (handled) {
                // Capacitor took the URL (e.g. opened another origin externally) and cancelled the load.
                disarm("handled-externally");
            } else if (request.isRedirect() && armed && isServerOrigin(request.getUrl())) {
                expectedUrl = stripFragment(request.getUrl().toString());
            }
        }
        return handled;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        String u = stripFragment(url);
        if (isErrorUrl(u)) {
            errorNavSeen = true;
            errorNavCount++;
            cancel(resetRunnable);
            disarm("error-page");
            Log.i(TAG, "error page started errorNavs=" + errorNavCount + " fires=" + fireCount);
        } else if (isServerOrigin(Uri.parse(u))) {
            if (armed && !u.equals(expectedUrl) && superseded.contains(u)) {
                Log.i(TAG, "stale commit ignored " + shape(u));
            } else {
                disarm("commit " + shape(u));
                startShownTimer();
            }
        } else if (armed) {
            disarm("other-origin commit");
        }
        super.onPageStarted(view, url, favicon);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        if (armed && isServerOrigin(Uri.parse(stripFragment(url)))) {
            finishedSinceArm = true;
            disarm("finished-without-commit");
        }
        super.onPageFinished(view, url);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) disarm("main-frame error " + error.getErrorCode());
        super.onReceivedError(view, request, error);
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request.isForMainFrame()) disarm("main-frame http " + errorResponse.getStatusCode());
        super.onReceivedHttpError(view, request, errorResponse);
    }
}
