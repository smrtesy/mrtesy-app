/** Popup — shows per-store connection status and a link to the web app. */
const SITE = "https://comparoz.com";
const LABELS = { amazon: "Amazon", walmart: "Walmart" };

function render(status) {
  const root = document.getElementById("stores");
  root.innerHTML = "";
  const stores = (status && status.stores) || {};
  for (const key of Object.keys(LABELS)) {
    const connected = stores[key] && stores[key].connected;
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "store";
    name.textContent = LABELS[key];
    const right = document.createElement("span");
    if (connected) {
      right.className = "pill on";
      right.textContent = "מחובר";
    } else {
      const btn = document.createElement("button");
      btn.className = "connect";
      btn.textContent = "התחבר";
      btn.onclick = () => chrome.runtime.sendMessage({ type: "comparoz.connect", store: key });
      right.appendChild(btn);
    }
    row.append(name, right);
    root.appendChild(row);
  }
  const link = document.createElement("a");
  link.className = "site";
  link.href = SITE;
  link.target = "_blank";
  link.textContent = "פתח את Comparoz";
  root.appendChild(link);
}

(async function loadStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "comparoz.status" });
    render(status || { stores: {} });
  } catch {
    render({ stores: {} });
  }
})();
