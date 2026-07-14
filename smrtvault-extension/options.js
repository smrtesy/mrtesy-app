"use strict";

const backendInput = document.getElementById("backendUrl");
const autoLockInput = document.getElementById("autoLock");
const DEFAULT_AUTO_LOCK_MIN = 5;

const captureToggle = document.getElementById("captureToggle");

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function load() {
  const { backendUrl, autoLockMin, captureEnabled } = await chrome.storage.local.get([
    "backendUrl",
    "autoLockMin",
    "captureEnabled",
  ]);
  if (backendUrl) backendInput.value = backendUrl;
  autoLockInput.value = Number(autoLockMin) > 0 ? Number(autoLockMin) : DEFAULT_AUTO_LOCK_MIN;
  captureToggle.checked = !!captureEnabled;
}

document.getElementById("saveBackend").addEventListener("click", async () => {
  const msg = document.getElementById("backendMsg");
  const raw = backendInput.value.trim().replace(/\/+$/, "");
  let origin;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") throw new Error("must be https");
    origin = u.origin + "/*";
  } catch {
    msg.style.color = "var(--err)";
    msg.textContent = "Enter a valid https:// URL.";
    return;
  }
  // Request permission to fetch from this backend origin (from this user gesture).
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    msg.style.color = "var(--err)";
    msg.textContent = "Permission to access that host was declined.";
    return;
  }
  await chrome.storage.local.set({ backendUrl: raw });
  // Drop any cached org id — it belonged to the previous backend.
  await chrome.storage.session.remove("sv_org");
  msg.style.color = "var(--primary)";
  msg.textContent = "Saved.";
});

document.getElementById("saveLock").addEventListener("click", async () => {
  const msg = document.getElementById("lockMsg");
  const n = Math.max(1, Math.min(120, Number(autoLockInput.value) || DEFAULT_AUTO_LOCK_MIN));
  autoLockInput.value = n;
  await chrome.storage.local.set({ autoLockMin: n });
  msg.style.color = "var(--primary)";
  msg.textContent = "Saved.";
});

captureToggle.addEventListener("change", async () => {
  const msg = document.getElementById("captureMsg");
  if (captureToggle.checked) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ["https://*/*"] });
    } catch {
      granted = false;
    }
    if (!granted) {
      captureToggle.checked = false;
      msg.style.color = "var(--err)";
      msg.textContent = "Permission to watch websites was declined — capture stays off.";
      return;
    }
    await send({ type: "ENABLE_CAPTURE" });
    msg.style.color = "var(--primary)";
    msg.textContent = "Capture is on. Sign in to a site to try it.";
  } else {
    await send({ type: "DISABLE_CAPTURE" });
    // Narrow back down: drop the broad grant. The backend-host permission was
    // granted independently when the URL was saved, so it survives this and
    // fill/list keep working.
    try {
      await chrome.permissions.remove({ origins: ["https://*/*"] });
    } catch {
      /* ignore */
    }
    msg.style.color = "var(--primary)";
    msg.textContent = "Capture is off.";
  }
});

document.getElementById("resetPin").addEventListener("click", async () => {
  const msg = document.getElementById("pinMsg");
  await chrome.storage.local.remove("sv_pin");
  await chrome.storage.session.remove("sv_unlocked");
  msg.style.color = "var(--primary)";
  msg.textContent = "PIN cleared. Create a new one from the popup.";
});

load();
