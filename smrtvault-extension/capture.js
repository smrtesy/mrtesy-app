/**
 * smrtVault capture content script (registered dynamically ONLY while the user
 * has enabled "capture logins" in options).
 *
 * It watches for a login being submitted and reports { url, username, password }
 * to the background worker, which — after checking it's a new login — asks the
 * user (via a notification) whether to save it to the vault. This script does not
 * store anything; it just reads the values the user just typed at submit time.
 */

(function () {
  "use strict";

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Extract { url, username, password } from a submitted form (or the whole page). */
  function extract(scopeEl) {
    const scope = scopeEl && scopeEl.querySelectorAll ? scopeEl : document;
    const pw = Array.from(scope.querySelectorAll('input[type="password"]')).find(
      (i) => !i.disabled && i.value && visible(i),
    );
    if (!pw || !pw.value) return null;

    const form = pw.form || scope;
    const all = Array.from(form.querySelectorAll("input"));
    const pwIdx = all.indexOf(pw);
    const userTypes = ["text", "email", "tel", "username", ""];
    let user = null;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (pwIdx !== -1 && i >= pwIdx) break;
      if (el.disabled || !visible(el)) continue;
      if (userTypes.includes((el.type || "").toLowerCase()) && el.value) user = el;
    }
    return { url: location.href, username: user ? user.value : null, password: pw.value };
  }

  function report(scopeEl) {
    try {
      const data = extract(scopeEl);
      if (data && data.password) {
        chrome.runtime.sendMessage({ type: "CAPTURE", data }, () => void chrome.runtime.lastError);
      }
    } catch {
      /* never interfere with the page */
    }
  }

  // Classic form submit.
  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target && e.target.tagName === "FORM" ? e.target : null;
      report(form);
    },
    true,
  );

  // Formless / SPA logins: a click on a button while a filled password field
  // exists. Debounced so a burst of clicks yields at most one report; the
  // background also de-dupes, so an over-eager trigger is harmless.
  let clickTimer = null;
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('button, input[type="submit"], [role="button"], a');
      if (!btn) return;
      const hasFilledPw = Array.from(document.querySelectorAll('input[type="password"]')).some((i) => i.value);
      if (!hasFilledPw) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => report(null), 50);
    },
    true,
  );
})();
