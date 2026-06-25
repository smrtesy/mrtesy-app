/**
 * Presence content script — runs only on comparoz.com.
 * Lets the website detect that the extension is installed and learn its ID,
 * so it can message the background worker via chrome.runtime.sendMessage(EXT_ID, …).
 */
(function () {
  try {
    const id = chrome.runtime.id;
    window.postMessage({ source: "comparoz-ext", installed: true, extId: id }, window.location.origin);
    // also expose a marker for synchronous checks
    document.documentElement.setAttribute("data-comparoz-ext", id);
  } catch (e) {
    /* extension context unavailable — ignore */
  }
})();
