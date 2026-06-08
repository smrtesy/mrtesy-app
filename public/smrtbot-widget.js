/**
 * smrtBot — embeddable web-chat loader.
 *
 * Drop this on any website to add the bot as a floating chat:
 *
 *   <script src="https://app.smrtesy.com/smrtbot-widget.js"
 *           data-key="wk_xxxxxxxx"
 *           data-lang="he"
 *           async></script>
 *
 * The data-key is the bot's public web key (copy it from the bot's Web tab).
 * Everything else — accent, icon, position, size, and the hover menu — is
 * configured from that tab and fetched from /api/bot/web/<key>/config, so the
 * snippet only ever carries the key. Hovering the launcher fans out the bot's
 * main-menu buttons; clicking one opens the chat pre-filled with that option.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute("data-key");
  if (!key) {
    console.error("[smrtbot-widget] missing data-key");
    return;
  }
  var lang = script.getAttribute("data-lang") || "he";

  var base;
  try {
    base = new URL(script.src).origin;
  } catch (e) {
    base = "";
  }

  var NS = "smrtbot-widget-" + key;
  if (document.getElementById(NS + "-launcher")) return; // already mounted

  var SIZES = {
    compact: { w: 340, h: 520 },
    standard: { w: 380, h: 600 },
    large: { w: 440, h: 680 },
  };

  fetch(base + "/api/bot/web/" + encodeURIComponent(key) + "/config")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) { mount(cfg || {}); })
    .catch(function () { mount({}); });

  function mount(cfg) {
    var accent = cfg.accent || "#2563eb";
    var position = cfg.position === "left" ? "left" : "right";
    var size = SIZES[cfg.size] || SIZES.standard;
    var menu = Array.isArray(cfg.menu) ? cfg.menu : [];
    var open = false;
    var widgetReady = false;
    var pendingPrefill = null;

    // ── Chat iframe ────────────────────────────────────────
    var frame = document.createElement("iframe");
    frame.id = NS + "-frame";
    frame.src = base + "/embed/smrtbot/" + encodeURIComponent(key) + "?lang=" + encodeURIComponent(lang);
    frame.title = "chat";
    frame.allow = "clipboard-write";
    frame.style.cssText = [
      "position:fixed", "bottom:88px", position + ":20px",
      "width:" + size.w + "px", "max-width:calc(100vw - 40px)",
      "height:" + size.h + "px", "max-height:calc(100vh - 120px)",
      "border:none", "border-radius:16px",
      "box-shadow:0 12px 40px rgba(0,0,0,0.28)",
      "z-index:2147483646", "background:#fff", "display:none", "overflow:hidden",
    ].join(";");

    // ── Hover menu (bot's main-menu buttons fanned above the launcher) ──
    var fan = document.createElement("div");
    fan.id = NS + "-fan";
    fan.style.cssText = [
      "position:fixed", "bottom:88px", position + ":20px",
      "z-index:2147483646", "display:none", "flex-direction:column",
      "align-items:" + (position === "left" ? "flex-start" : "flex-end"),
      "gap:8px", "max-width:calc(100vw - 40px)",
    ].join(";");
    menu.forEach(function (item) {
      if (!item || !item.id || !item.title) return;
      var b = document.createElement("button");
      b.textContent = item.title;
      b.dir = "auto";
      b.style.cssText = [
        "border:none", "cursor:pointer", "border-radius:9999px",
        "padding:8px 14px", "font-size:13px", "font-weight:600",
        "background:#fff", "color:" + accent,
        "box-shadow:0 4px 14px rgba(0,0,0,0.18)", "white-space:nowrap",
        "max-width:240px", "overflow:hidden", "text-overflow:ellipsis",
      ].join(";");
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        openChat({ buttonId: item.id, title: item.title });
        hideFan();
      });
      fan.appendChild(b);
    });

    // ── Launcher button ────────────────────────────────────
    var launcher = document.createElement("button");
    launcher.id = NS + "-launcher";
    launcher.setAttribute("aria-label", "chat");
    launcher.style.cssText = [
      "position:fixed", "bottom:20px", position + ":20px",
      "width:56px", "height:56px", "border-radius:9999px", "border:none",
      "cursor:pointer", "background:" + accent, "color:#fff",
      "box-shadow:0 6px 20px rgba(0,0,0,0.25)", "z-index:2147483647",
      "display:flex", "align-items:center", "justify-content:center",
      "padding:0", "overflow:hidden", "transition:transform .15s ease",
    ].join(";");
    if (cfg.icon_url) {
      var img = document.createElement("img");
      img.src = cfg.icon_url;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover";
      launcher.appendChild(img);
    } else {
      launcher.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    }

    // ── Behaviour ──────────────────────────────────────────
    function setOpen(next) {
      open = next;
      frame.style.display = open ? "block" : "none";
      launcher.style.transform = open ? "scale(0.92)" : "scale(1)";
      if (open) hideFan();
    }
    function openChat(prefill) {
      setOpen(true);
      if (prefill) {
        pendingPrefill = prefill;
        if (widgetReady) flushPrefill();
      }
    }
    function flushPrefill() {
      if (!pendingPrefill) return;
      frame.contentWindow.postMessage({ type: "smrtbot:prefill", buttonId: pendingPrefill.buttonId, title: pendingPrefill.title }, base || "*");
      pendingPrefill = null;
    }

    var fanTimer = null;
    function showFan() {
      if (open || menu.length === 0) return;
      if (fanTimer) clearTimeout(fanTimer);
      fan.style.display = "flex";
    }
    function hideFan() {
      fan.style.display = "none";
    }
    function scheduleHide() {
      if (fanTimer) clearTimeout(fanTimer);
      fanTimer = setTimeout(hideFan, 250);
    }
    launcher.addEventListener("mouseenter", showFan);
    launcher.addEventListener("mouseleave", scheduleHide);
    fan.addEventListener("mouseenter", showFan);
    fan.addEventListener("mouseleave", scheduleHide);
    launcher.addEventListener("click", function () { setOpen(!open); });

    window.addEventListener("message", function (ev) {
      if (base && ev.origin !== base) return;
      var d = ev.data || {};
      if (d.type === "smrtbot:close") setOpen(false);
      else if (d.type === "smrtbot:ready") { widgetReady = true; flushPrefill(); }
    });

    function attach() {
      document.body.appendChild(frame);
      document.body.appendChild(fan);
      document.body.appendChild(launcher);
    }
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach);
  }
})();
