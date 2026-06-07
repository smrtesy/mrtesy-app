/**
 * smrtBot — embeddable web-chat loader.
 *
 * Drop this on any website to add the bot as a floating chat:
 *
 *   <script src="https://app.smrtesy.com/smrtbot-widget.js"
 *           data-key="wk_xxxxxxxx"
 *           data-accent="#2563eb"
 *           data-lang="he"
 *           data-position="right"
 *           async></script>
 *
 * The data-key is the bot's public web key (copy it from the bot's Web tab).
 * It injects a launcher button + an iframe pointing at /embed/smrtbot/<key>
 * on this same origin, so the chat (API + Realtime) runs first-party.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute("data-key");
  if (!key) {
    console.error("[smrtbot-widget] missing data-key");
    return;
  }
  var accent = script.getAttribute("data-accent") || "#2563eb";
  var lang = script.getAttribute("data-lang") || "he";
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";

  // Base origin = wherever this script was served from.
  var base;
  try {
    base = new URL(script.src).origin;
  } catch (e) {
    base = "";
  }

  var NS = "smrtbot-widget-" + key;
  if (document.getElementById(NS + "-launcher")) return; // already mounted

  var open = false;

  // ── Launcher button ──────────────────────────────────────
  var launcher = document.createElement("button");
  launcher.id = NS + "-launcher";
  launcher.setAttribute("aria-label", "chat");
  launcher.style.cssText = [
    "position:fixed",
    "bottom:20px",
    position + ":20px",
    "width:56px",
    "height:56px",
    "border-radius:9999px",
    "border:none",
    "cursor:pointer",
    "background:" + accent,
    "color:#fff",
    "box-shadow:0 6px 20px rgba(0,0,0,0.25)",
    "z-index:2147483646",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "transition:transform .15s ease",
  ].join(";");
  launcher.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  // ── Chat iframe ──────────────────────────────────────────
  var frame = document.createElement("iframe");
  frame.id = NS + "-frame";
  frame.src = base + "/embed/smrtbot/" + encodeURIComponent(key) + "?lang=" + encodeURIComponent(lang);
  frame.title = "chat";
  frame.allow = "clipboard-write";
  frame.style.cssText = [
    "position:fixed",
    "bottom:88px",
    position + ":20px",
    "width:380px",
    "max-width:calc(100vw - 40px)",
    "height:600px",
    "max-height:calc(100vh - 120px)",
    "border:none",
    "border-radius:16px",
    "box-shadow:0 12px 40px rgba(0,0,0,0.28)",
    "z-index:2147483646",
    "background:#fff",
    "display:none",
    "overflow:hidden",
  ].join(";");

  function setOpen(next) {
    open = next;
    frame.style.display = open ? "block" : "none";
    launcher.style.transform = open ? "scale(0.92)" : "scale(1)";
  }

  launcher.addEventListener("click", function () {
    setOpen(!open);
  });

  // The widget asks to close itself via postMessage.
  window.addEventListener("message", function (ev) {
    if (base && ev.origin !== base) return;
    if (ev.data && ev.data.type === "smrtbot:close") setOpen(false);
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(launcher);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
