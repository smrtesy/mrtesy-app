"use strict";

const APP_URL = "https://app.smrtesy.com";

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

const view = document.getElementById("view");
const lockBtn = document.getElementById("lockBtn");

function tpl(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

async function activeTabHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? hostOf(tab.url) : "";
  } catch {
    return "";
  }
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "sv-toast";
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => el.remove(), 1400);
}

// ── renderers ──────────────────────────────────────────────────────────────

function showNoBackend() {
  view.replaceChildren(tpl("tpl-no-backend"));
}

function showLoggedOut() {
  view.replaceChildren(tpl("tpl-logged-out"));
}

function showSetPin() {
  view.replaceChildren(tpl("tpl-set-pin"));
  document.getElementById("newPin").focus();
}

function showLocked() {
  view.replaceChildren(tpl("tpl-locked"));
  const pin = document.getElementById("pin");
  pin.focus();
  pin.addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
}

async function showUnlocked() {
  view.replaceChildren(tpl("tpl-unlocked"));
  lockBtn.hidden = false;
  const search = document.getElementById("search");
  const listEl = document.getElementById("list");
  const listMsg = document.getElementById("listMsg");

  const res = await send({ type: "LIST" });
  if (res.error) {
    if (res.error === "locked") return render();
    listMsg.textContent = "Couldn't load logins: " + res.error;
    return;
  }
  const creds = res.credentials || [];
  const host = await activeTabHost();

  function score(c) {
    const h = hostOf(c.url || "");
    if (host && h && (h === host || host.endsWith("." + h) || h.endsWith("." + host))) return 0;
    return 1;
  }

  function draw(filter) {
    const q = filter.trim().toLowerCase();
    const items = creds
      .filter((c) => !q || [c.label, c.username, c.url].some((v) => (v || "").toLowerCase().includes(q)))
      .sort((a, b) => score(a) - score(b) || (a.label || "").localeCompare(b.label || ""));
    listEl.replaceChildren();
    if (items.length === 0) {
      listMsg.textContent = creds.length === 0 ? "No logins in your vault yet." : "No matches.";
      return;
    }
    listMsg.textContent = "";
    for (const c of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "sv-item";
      btn.innerHTML =
        '<span class="sv-key">🔑</span>' +
        '<span class="sv-labels"><span class="sv-label"></span><span class="sv-user"></span></span>' +
        (score(c) === 0 ? '<span class="sv-match">this site</span>' : "");
      btn.querySelector(".sv-label").textContent = c.label || "(untitled)";
      btn.querySelector(".sv-user").textContent = c.username || "";
      btn.addEventListener("click", () => doFill(c.id, c.label, c.url));
      li.appendChild(btn);
      listEl.appendChild(li);
    }
  }

  search.addEventListener("input", () => draw(search.value));
  draw("");
}

// ── actions ──────────────────────────────────────────────────────────────────

async function doSetPin() {
  const p1 = document.getElementById("newPin").value;
  const p2 = document.getElementById("newPin2").value;
  const err = document.getElementById("pinErr");
  if (p1.length < 4) { err.textContent = "PIN must be at least 4 characters."; return; }
  if (p1 !== p2) { err.textContent = "PINs don't match."; return; }
  const res = await send({ type: "SET_PIN", pin: p1 });
  if (res.ok) render();
  else err.textContent = "Couldn't set PIN: " + (res.error || "error");
}

async function doUnlock() {
  const pin = document.getElementById("pin").value;
  const err = document.getElementById("unlockErr");
  const res = await send({ type: "UNLOCK", pin });
  if (res.ok) render();
  else err.textContent = "Wrong PIN.";
}

function sameSite(a, b) {
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

async function doFill(id, label, url) {
  // Phishing guard: if the login is tied to a URL, confirm before filling it
  // into a page on a different host than it belongs to.
  const credHost = hostOf(url || "");
  const tabHost = await activeTabHost();
  if (credHost && tabHost && !sameSite(credHost, tabHost)) {
    if (!confirm(`This login is for "${credHost}". Fill it on "${tabHost}" anyway?`)) return;
  }
  const res = await send({ type: "FILL", id });
  if (res.ok) {
    toast("Filled " + (label || "login"));
    setTimeout(() => window.close(), 700);
  } else {
    const reason = res.error === "no_password_field" ? "No login field found on this page." : (res.error || "Fill failed.");
    toast(reason);
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

async function render() {
  lockBtn.hidden = true;
  const s = await send({ type: "STATE" });
  if (!s || s.error) { view.textContent = "Error: " + ((s && s.error) || "no response"); return; }
  if (!s.backendConfigured) return showNoBackend();
  if (!s.loggedIn) return showLoggedOut();
  if (!s.pinSet) return showSetPin();
  if (!s.unlocked) return showLocked();
  return showUnlocked();
}

document.addEventListener("click", (e) => {
  const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
  if (!act) return;
  if (act === "options") chrome.runtime.openOptionsPage();
  else if (act === "open-app") chrome.tabs.create({ url: APP_URL });
  else if (act === "set-pin") doSetPin();
  else if (act === "unlock") doUnlock();
});

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

lockBtn.addEventListener("click", async () => {
  await send({ type: "LOCK" });
  render();
});

render();
