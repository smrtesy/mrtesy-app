"use strict";

const backendInput = document.getElementById("backendUrl");
const autoLockInput = document.getElementById("autoLock");
const DEFAULT_AUTO_LOCK_MIN = 5;

async function load() {
  const { backendUrl, autoLockMin } = await chrome.storage.local.get(["backendUrl", "autoLockMin"]);
  if (backendUrl) backendInput.value = backendUrl;
  autoLockInput.value = Number(autoLockMin) > 0 ? Number(autoLockMin) : DEFAULT_AUTO_LOCK_MIN;
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

document.getElementById("resetPin").addEventListener("click", async () => {
  const msg = document.getElementById("pinMsg");
  await chrome.storage.local.remove("sv_pin");
  await chrome.storage.session.remove("sv_unlocked");
  msg.style.color = "var(--primary)";
  msg.textContent = "PIN cleared. Create a new one from the popup.";
});

load();
