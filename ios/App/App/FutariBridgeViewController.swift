import UIKit
import WebKit
import Capacitor
import os

// Load watchdog for the thin shell (#1672).
//
// Capacitor has no load timeout (iOS `loadWebView()` uses a 60 s URLRequest). On a stalled network the
// WKWebView sits blank until that timeout fires. This controller arms a timer when a main-frame load
// toward the server origin starts, disarms it when a server-origin document COMMITS (a document-start
// user script reports it), and on expiry calls `stopLoading()`. Capacitor then loads `errorPathURL`
// (offline.html) itself from `didFailProvisionalNavigation`, once. The delegation handler is NOT
// replaced or wrapped.
//
// Rules mirrored from scripts/native-offline-logic.ts (which has the unit tests): timeouts 6 -> 15 -> 30 s,
// then stays at 30 s (never disabled); the counter resets only after a server document was shown for
// 60 s with no fire, or after > 5 min in the background. Fragment-only navigations do not arm (#1680, Swift
// only). Change both together.
//
// Failure looks like: nothing. A watchdog that never arms leaves the old blank screen; one that fires on
// a normal load flashes the offline page. Watch: `log stream --predicate 'category == "FutariWatchdog"'`.

private let watchdogLog = OSLog(subsystem: "dev.southernlight.futari", category: "FutariWatchdog")

private enum Watchdog {
    static let timeoutsSeconds: [Double] = [6, 15, 30]
    static let resetAfterShown: TimeInterval = 60
    static let resetAfterBackground: TimeInterval = 5 * 60
    static let errorNavGrace: TimeInterval = 0.5
    static let supersededMax = 8

    static func timeout(forConsecutiveFires n: Int) -> Double {
        timeoutsSeconds[min(max(n, 0), timeoutsSeconds.count - 1)]
    }
}

/// Mirrors isFragmentOnlyNavigation in scripts/native-offline-logic.ts (Swift only; Android never sees
/// in-page navigations in shouldInterceptRequest). A wrong "true" silently leaves a real load unwatched
/// (the #1672 blank screen); a wrong "false" flashes the offline page over a loaded page.
private func isFragmentOnlyNavigation(target: String, current: String?, isReload: Bool) -> Bool {
    guard !isReload, let current = current, target.contains("#") else { return false }
    func strip(_ s: String) -> String {
        if let i = s.firstIndex(of: "#") { return String(s[s.startIndex..<i]) }
        return s
    }
    return strip(target) == strip(current)
}

/// Weak proxy so the user content controller does not retain the view controller.
private final class CommitHandler: NSObject, WKScriptMessageHandler {
    weak var target: FutariBridgeViewController?
    init(_ target: FutariBridgeViewController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.didReceiveCommit(message)
    }
}

class FutariBridgeViewController: CAPBridgeViewController {
    private var observers: [NSObjectProtocol] = []
    private var kvo: [NSKeyValueObservation] = []

    private var gen = 0
    private var armed = false
    private var expectedUrl: String?
    private var superseded: [String] = []
    private var armAt: CFTimeInterval = 0
    private var fireWork: DispatchWorkItem?
    private var resetWork: DispatchWorkItem?
    private var consecutiveFires = 0
    private var backgroundedAt: Date?
    // counters (acceptance reads these from the log)
    private var fireCount = 0
    private var errorNavCount = 0
    private var errorNavsSinceFire = 0

    private func log(_ message: String) {
        os_log("FutariWatchdog %{public}@", log: watchdogLog, type: .info, message)
    }

    private var serverURL: URL? { bridge?.config.serverURL }

    private func isServerOrigin(_ url: URL?) -> Bool {
        guard let url = url, let server = serverURL else { return false }
        return url.scheme == server.scheme && url.host == server.host && url.port == server.port
    }

    private func isErrorURL(_ url: URL?) -> Bool {
        guard let url = url, let error = bridge?.config.errorPathURL else { return false }
        return url.absoluteString.hasPrefix(Self.stripFragment(error.absoluteString))
    }

    private static func stripFragment(_ s: String) -> String {
        if let i = s.firstIndex(of: "#") { return String(s[s.startIndex..<i]) }
        return s
    }

    /// Log shape only (first path segment): URLs can carry share tokens.
    private static func shape(_ s: String) -> String {
        guard let path = URL(string: s)?.path, path.count > 1 else { return "/" }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        return parts.count > 1 ? "/\(parts[0])/*" : "/\(parts[0])"
    }

    // capacitorDidLoad runs from loadView(): the WKWebView exists, before it is in the hierarchy and
    // before loadWebView(). Capacitor has already replaced the userContentController.
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView else { return }

        let script = WKUserScript(
            source: "window.webkit.messageHandlers.futariCommit.postMessage(location.href);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        let controller = webView.configuration.userContentController
        controller.addUserScript(script)
        controller.add(CommitHandler(self), name: "futariCommit")

        // Counts error-page navigations (exactly one per fire is the invariant).
        kvo.append(webView.observe(\.url, options: [.new]) { [weak self] web, _ in
            guard let self = self, self.isErrorURL(web.url) else { return }
            self.errorNavCount += 1
            self.errorNavsSinceFire += 1
            self.resetWork?.cancel()
            self.disarm("error-page")
            self.log("error page loaded errorNavs=\(self.errorNavCount) fires=\(self.fireCount)")
        })

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .capacitorDecidePolicyForNavigationAction, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, let action = note.object as? WKNavigationAction else { return }
            guard action.targetFrame?.isMainFrame ?? false else { return }
            let url = action.request.url
            if self.isErrorURL(url) { return }
            if self.isServerOrigin(url), (action.request.httpMethod ?? "GET") == "GET" {
                // Fragment-only in-page navigation (#1680): no new document, so the commit script never
                // runs and the timer could never disarm. Raw URLs, current = webView.url right now (pushState
                // updates it; expectedUrl and the committed href are not). Armed state is left untouched.
                if isFragmentOnlyNavigation(
                    target: url?.absoluteString ?? "", current: self.webView?.url?.absoluteString,
                    isReload: action.navigationType == .reload) {
                    self.log("SKIP fragment-only \(Self.shape(url?.absoluteString ?? ""))")
                    return
                }
                self.arm(Self.stripFragment(url?.absoluteString ?? ""))
            } else if self.armed {
                // Left the server origin (e.g. a redirect Capacitor opens externally): nothing to time out.
                self.disarm("left server origin")
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.backgroundedAt = Date() })
        observers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            if let at = self.backgroundedAt, Date().timeIntervalSince(at) > Watchdog.resetAfterBackground {
                if self.consecutiveFires != 0 { self.log("escalation reset (background > 5 min)") }
                self.consecutiveFires = 0
            }
            self.backgroundedAt = nil
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: commit signal

    fileprivate func didReceiveCommit(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let href = message.body as? String,
              isServerOrigin(URL(string: href)) else { return }
        let url = Self.stripFragment(href)
        if armed, url != expectedUrl, superseded.contains(url) {
            log("stale commit ignored \(Self.shape(url))")
            return
        }
        disarm("commit \(Self.shape(url))")
        startShownTimer()
    }

    // MARK: arm / disarm / fire

    private func arm(_ url: String) {
        if armed, let previous = expectedUrl, previous != url {
            superseded.removeAll { $0 == previous }
            superseded.append(previous)
            if superseded.count > Watchdog.supersededMax { superseded.removeFirst() }
        }
        superseded.removeAll { $0 == url }
        fireWork?.cancel()
        resetWork?.cancel()
        gen += 1
        armed = true
        expectedUrl = url
        armAt = CACurrentMediaTime()
        let g = gen
        let timeout = Watchdog.timeout(forConsecutiveFires: consecutiveFires)
        let work = DispatchWorkItem { [weak self] in self?.fire(g, timeout: timeout) }
        fireWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
        log("arm gen=\(g) timeout=\(Int(timeout))s consecutive=\(consecutiveFires) \(Self.shape(url))")
    }

    private func disarm(_ why: String) {
        guard armed else { return }
        armed = false
        fireWork?.cancel()
        log(String(format: "disarm gen=%d (%@) after %.0fms", gen, why, (CACurrentMediaTime() - armAt) * 1000))
    }

    private func fire(_ g: Int, timeout: Double) {
        guard g == gen, armed else { return }
        armed = false
        // Pending guard: only act while the load is still in flight.
        guard let web = webView, web.isLoading else {
            log("fire skipped gen=\(g) not loading")
            return
        }
        consecutiveFires += 1
        fireCount += 1
        errorNavsSinceFire = 0
        resetWork?.cancel()
        log("FIRE gen=\(g) after \(Int(timeout))s fires=\(fireCount) errorNavs=\(errorNavCount) nextTimeout=\(Int(Watchdog.timeout(forConsecutiveFires: consecutiveFires)))s")
        // stopLoading() only: Capacitor loads errorPathURL from didFailProvisionalNavigation, once.
        web.stopLoading()
        // Guarded fallback in case a future Capacitor stops doing that (count still 0 after 500 ms).
        DispatchQueue.main.asyncAfter(deadline: .now() + Watchdog.errorNavGrace) { [weak self] in
            guard let self = self, g == self.gen, !self.armed, self.errorNavsSinceFire == 0,
                  let errorURL = self.bridge?.config.errorPathURL else { return }
            self.log("fallback load(errorPathURL): Capacitor did not load it")
            self.errorNavsSinceFire += 1
            self.webView?.load(URLRequest(url: errorURL))
        }
    }

    /// A server-origin document is on screen: after 60 s with no fire, the escalation resets.
    private func startShownTimer() {
        resetWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.consecutiveFires != 0 { self.log("escalation reset (shown 60 s, no fire)") }
            self.consecutiveFires = 0
        }
        resetWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Watchdog.resetAfterShown, execute: work)
    }
}
