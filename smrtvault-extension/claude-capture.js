/**
 * smrtesy claude-capture content script — runs on claude.ai/code/* to report the
 * current session's link + a best-effort status back to smrtesy (via the
 * background worker → POST /api/tasks/claude-actions), so the workclock bar can
 * track "work with Claude" without the user babysitting the tab
 * (docs/workclock-plan.md §11).
 *
 * ⚠️ HEURISTIC + UNVERIFIED. There is NO official Claude status API — this reads
 * the page. The most reliable signal is claude.ai's own notification (it fires
 * exactly when Claude finishes / needs you); title changes are a cheap backup;
 * DOM structure is the most fragile and WILL need tuning against the live UI.
 * Test in a real browser and adjust the selectors in detectDomStatus().
 */
(function () {
  "use strict";
  if (!location.pathname.startsWith("/code")) return;

  var last = { url: "", status: "", title: "" };

  function report(status) {
    var data = { session_url: location.href, status: status, title: document.title.slice(0, 200) };
    if (data.url === last.url && data.status === last.status && data.title === last.title) return;
    last = { url: data.url, status: data.status, title: data.title };
    try {
      chrome.runtime.sendMessage({ type: "CLAUDE_STATUS", data: data }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* extension context gone — ignore */ }
  }

  // 1) Notification intercept (most precise). Inject a page-world shim that wraps
  //    window.Notification so a fired notification (Claude done / awaiting input)
  //    posts a message the content script can see.
  try {
    var s = document.createElement("script");
    s.textContent =
      "(function(){try{var N=window.Notification;if(!N||N.__smrtesyWrapped)return;" +
      "var W=function(t,o){try{window.postMessage({__smrtesy_claude:1,title:String(t||'')},location.origin);}catch(e){}return new N(t,o);};" +
      "W.__smrtesyWrapped=1;W.requestPermission=N.requestPermission&&N.requestPermission.bind(N);" +
      "try{Object.defineProperty(W,'permission',{get:function(){return N.permission;}});}catch(e){}" +
      "window.Notification=W;}catch(e){}})();";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) { /* CSP may block the shim — title/DOM signals still work */ }

  window.addEventListener("message", function (ev) {
    if (ev.source === window && ev.data && ev.data.__smrtesy_claude) report("waiting");
  });

  // 2) Title changes — Claude marks attention in the tab title.
  try {
    var titleEl = document.querySelector("title");
    if (titleEl) new MutationObserver(function () { report(detectDomStatus()); }).observe(titleEl, { childList: true });
  } catch (e) { /* ignore */ }

  // 3) DOM heuristic — a "stop"/generating control present ⇒ running, else
  //    waiting. Selectors are best-effort; tune against the real UI.
  function detectDomStatus() {
    try {
      var stop = document.querySelector('[aria-label*="stop" i],[data-testid*="stop" i]');
      if (stop) return "running";
    } catch (e) { /* ignore */ }
    return "waiting";
  }

  report("running");
  setInterval(function () { report(detectDomStatus()); }, 30000);
  window.addEventListener("beforeunload", function () { report("done"); });
})();
