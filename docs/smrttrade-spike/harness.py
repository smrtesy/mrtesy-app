"""smrtTrade — רתמת גירסת-בדיקה (T1.4).

מוכיח את השרשרת מקצה-לקצה: טוען את מרשם-הכללים (192) → מושך OHLCV נקודת-בזמן
מ-Yahoo (חינם) → מחשב אינדיקטורים → מעריך כלל-אחר-כלל → מפיק פנקס-כיסוי מלא
(כל 192 הכללים מקבלים סטטוס, אפס פספוס-שקט) → מחליט כניסה/מעקב/הימנעות →
משווה מול פסק-הדין הנעול של 14/07.

שיטת-קריאה: נומרי (A) בלבד — בלי vision. כללי-vision מסומנים NEEDS_VISION,
כללי-שיפוט מסומנים MANUAL, וכללים computable ללא מעריך מסומנים NO_EVALUATOR
(בייצור = fail-closed/בנייה נכשלת). זה בדיוק מנגנון הבטחת-הכיסוי.

הרצה:  python3 harness.py TICKER [TICKER ...]   (ברירת מחדל: DE RKLB)
"""
import json, sys, os, time, urllib.request, datetime
import numpy as np
import indicators as I
import levels as L

CUTOFF = "2026-07-14"                       # חומת אי-דליפה: נקודת-בזמן, בלי הצצה קדימה
HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "..", "stock-course-rules.registry.json")

# פסק-הדין הנעול של 14/07 (docs/ziv-blind-test-2026-07-14.md) — לצורך השוואה בלבד.
LOCKED = {
    "DE": "מעקב→כניסה", "MU": "מעקב", "GLW": "מעקב", "LIN": "מעקב", "SN": "מעקב",
    "OGN": "מעקב", "RIOT": "מעקב", "RKLB": "הימנעות", "CMRE": "הימנעות",
}


def fetch(ticker, rng="2y", interval="1d"):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?range={rng}&interval={interval}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        o, h, l, c, v = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
        if None in (o, h, l, c):
            continue
        dt = datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
        if dt > CUTOFF:                     # נקודת-בזמן — חותכים כל מה שאחרי 14/07
            continue
        rows.append((dt, o, h, l, c, v or 0))
    return rows


def to_weekly(daily):
    """איגוד יומי לשבועי לפי מספר-שבוע ISO."""
    buckets = {}
    for dt, o, h, l, c, v in daily:
        y, w, _ = datetime.date.fromisoformat(dt).isocalendar()
        key = (y, w)
        b = buckets.setdefault(key, [dt, o, h, l, c, v])
        b[2] = max(b[2], h); b[3] = min(b[3], l); b[4] = c; b[5] += v; b[0] = dt
    return [tuple(buckets[k]) for k in sorted(buckets)]


def build_context(ticker, daily, weekly, spy_ctx):
    dc = [r[4] for r in daily]; dh = [r[2] for r in daily]; dl = [r[3] for r in daily]; dv = [r[5] for r in daily]
    wc = [r[4] for r in weekly]; wh = [r[2] for r in weekly]; wl = [r[3] for r in weekly]
    price = dc[-1]
    d_trend, d_highs, d_lows = I.trend_structure(dh, dl, k=5)
    w_trend, w_highs, w_lows = I.trend_structure(wh, wl, k=3)
    macd_d, sig_d = I.macd(dc)
    atr = I.atr(dh, dl, dc, 14)
    ath = max(dh)
    # ── רמות משמעותיות (גלאי-אשכול) + סטאפ-כניסה אידיאלי ──
    lv = L.levels(daily, weekly)
    tgt = L.significant_target(lv)                 # התנגדות משמעותית מעל
    sup_zone = L.significant_stop_support(lv)      # תמיכה משמעותית מתחת (יעד-פולבק)
    res_c = tgt["center"] if tgt else None
    sup_c = sup_zone["center"] if sup_zone else None
    # סטאפ אידיאלי: כניסה בפולבק לתמיכה (ז-2: מעט מעל), סטופ מתחת עם אוויר-ATR
    entry_ideal = sup_c * 1.005 if sup_c else None
    stop_ideal = (sup_c - 0.25 * atr) if sup_c else None
    rr_setup = None
    if entry_ideal and stop_ideal and res_c and (entry_ideal - stop_ideal) > 0:
        rr_setup = (res_c - entry_ideal) / (entry_ideal - stop_ideal)
    at_support = sup_c is not None and price <= sup_c * 1.02   # המחיר כבר באזור-הכניסה
    ctx = dict(
        ticker=ticker, price=price, date=daily[-1][0],
        sma20=I.sma(dc, 20), sma50=I.sma(dc, 50), sma200=I.sma(dc, 200),
        rsi_d=I.rsi(dc, 14), rsi_w=I.rsi(wc, 14),
        macd_d=macd_d, macd_sig_d=sig_d, atr_d=atr,
        vol_avg20=float(np.mean(dv[-20:])) if len(dv) >= 20 else float(np.mean(dv)),
        d_trend=d_trend, w_trend=w_trend,
        resistance=res_c, support=sup_c,
        entry_ideal=entry_ideal, stop_ideal=stop_ideal, target_ideal=res_c,
        rr_setup=rr_setup, at_support=at_support,
        ath=ath, pct_from_high=(price / ath - 1) * 100,
        dist_to_res_pct=(res_c / price - 1) * 100 if res_c else None,
        n_candles=len(daily),
        spy_above_200=spy_ctx["above_200"] if spy_ctx else None,
    )
    return ctx


# ─────────────────────────── מעריכים (evaluator functions) ───────────────────────────
# כל מעריך מחזיר (status, detail). status ∈ PASS/FAIL/N/A.
P, F, NA = "PASS", "FAIL", "N/A"

def E(cond, why_pass, why_fail):
    return (P, why_pass) if cond else (F, why_fail)

EVAL = {
    # א — סינון
    "א-5":  lambda c: E(c["price"] > 5, f"מחיר {c['price']:.2f}$ > 5", f"מחיר {c['price']:.2f}$ ≤ 5"),
    "א-4":  lambda c: E(c["vol_avg20"] > 1e6, f"מחזור ~{c['vol_avg20']/1e6:.1f}M > 1M", f"מחזור {c['vol_avg20']/1e6:.2f}M < 1M"),
    "א-9":  lambda c: E(c["price"] > c["sma200"] and c["price"] < c["sma50"],
                       "סטאפ תיקון-במגמה: מעל SMA200 ומתחת SMA50", "לא במצב תיקון-במגמה (מעל/מתחת ל-MA)"),
    # ב — מגמה
    "ב-3":  lambda c: E(c["w_trend"] != "down", f"מגמה שבועית {c['w_trend']} — לא נגד המגמה",
                       "מגמה שבועית יורדת — לונג נגד המגמה אסור (סכין נופלת)"),
    "ב-10": lambda c: E(c["w_trend"] == "up", "מגמת עלייה — שפל אחרון לא נשבר", "לא במגמת עלייה מובהקת"),
    "ב-17": lambda c: E(c["w_trend"] == "up", "מבנה: שיאים+שפלים עולים (מגמה ראשית עולה)", "אין מבנה מגמה-ראשית-עולה"),
    # ג — תמיכה/התנגדות
    "ג-10": lambda c: E(c["dist_to_res_pct"] is None or c["dist_to_res_pct"] > 3,
                       f"מרחק להתנגדות {c['dist_to_res_pct']:.1f}% > 3% — לא צמוד" if c["dist_to_res_pct"] is not None else "אין התנגדות קרובה",
                       f"צמוד להתנגדות ({c['dist_to_res_pct']:.1f}%) — אין לקנות לפני התנגדות"),
    # ו — אינדיקטורים
    "ו-2":  lambda c: E(c["w_trend"] != "up" or c["rsi_w"] > 45,
                       f"RSI שבועי {c['rsi_w']:.0f} מתאים למגמה", f"RSI שבועי {c['rsi_w']:.0f} חלש למגמה עולה"),
    "ו-4":  lambda c: E(c["w_trend"] == "up" and c["price"] <= c["sma50"] * 1.03,
                       "כניסה-עם-המגמה: פולבק במגמה עולה", "לא מצב כניסה-עם-המגמה (לא פולבק/לא עלייה)"),
    "ו-12": lambda c: E(c["sma50"] > c["sma200"], "MA50>MA200 — מבנה עולה", "MA50<MA200 — מבנה לא-עולה"),
    # י — יעד ויחס
    "י-1":  lambda c: _rr(c),
    "י-3":  lambda c: _rr(c, gate=True),
    # יב — עיתוי/מאקרו
    "יב-5": lambda c: E(c["pct_from_high"] > -50, f"{c['pct_from_high']:.0f}% מהשיא (>-50%) — איכותית",
                       f"{c['pct_from_high']:.0f}% מהשיא (<-50%) — לא איכותית"),
    # ENG — תוספת הנדסית (לא בקורס): שער מגמת-שוק
    "ENG-SPY": lambda c: E(c["spy_above_200"] is True, "SPY מעל SMA200 — משטר עולה, לונג מותר",
                          "SPY מתחת SMA200 — משטר-שורט, לונג חסום"),
}

def _rr(c, gate=False):
    """יחס סיכוי/סיכון של הסטאפ: כניסה בפולבק לתמיכה, סטופ מתחתיה, יעד=התנגדות."""
    rr = c.get("rr_setup")
    if rr is None:
        return (NA, "אין סטאפ תקף (חסרה תמיכה/התנגדות משמעותית)")
    txt = (f"R:R≈1:{rr:.1f} (כניסה {c['entry_ideal']:.1f} / "
           f"סטופ {c['stop_ideal']:.1f} / יעד {c['target_ideal']:.1f})")
    return (P, txt) if rr >= 2 else (F, txt + " < 1:2")


def decide(c, ledger):
    """החלטה מבוססת-שערים, במראה לשיטה הידנית של 14/07."""
    def st(rid): return ledger[rid][0]
    # 0) פילטרים בסיסיים
    if st("א-5") == F or st("א-4") == F:
        return "נפסל", "לא עובר פילטר סחירות/מחיר בסיסי"
    # 1) שער מגמת-שוק (הנדסי)
    spy_block = st("ENG-SPY") == F
    # 2) מגמה נגדית / סכין נופלת
    if st("ב-3") == F:
        return "הימנעות", "מגמה שבועית יורדת — סכין נופלת (ב-3)"
    if c["price"] < c["sma200"]:
        return "הימנעות", "מתחת ל-SMA200 — אין מגמת עלייה"
    # 3) צמוד להתנגדות → מעקב
    if st("ג-10") == F:
        return "מעקב", "צמוד להתנגדות — לא קונים לפני התנגדות (ג-10)"
    # 4) יחס-סטאפ לא מספיק → מעקב/הימנעות
    if st("י-3") == F:
        return "מעקב", f"יחס-סטאפ < 1:2 (י-3) — {ledger['י-1'][1]}"
    # 5) טריגר-כניסה: המחיר כבר באזור-הכניסה (פולבק לתמיכה) במגמה עולה
    if spy_block:
        return "מעקב", "השוק הכללי (SPY) לא תומך — כניסה מוקפאת"
    if c["at_support"] and c["w_trend"] == "up":
        return "כניסה", f"פולבק לתמיכה במגמה עולה, {ledger['י-1'][1]}"
    return "מעקב", f"מגמה תומכת ויחס טוב, אך אין טריגר עדיין — ממתין לפולבק לכניסה {c['entry_ideal']:.1f}"


def evaluate(reg, ctx):
    """פנקס-כיסוי: כל 192 הכללים מקבלים סטטוס — אפס פספוס-שקט."""
    ledger = {}
    for r in reg["rules"]:
        rid = r["id"]
        if rid in EVAL:
            try:
                ledger[rid] = EVAL[rid](ctx)
            except Exception as e:
                ledger[rid] = ("UNKNOWN", f"שגיאת-הערכה: {e}")
        elif r["evaluable"] == "vision":
            ledger[rid] = ("NEEDS_VISION", "דורש קריאת-תמונה — לא בשיטה הנומרית")
        elif r["evaluable"] == "manual":
            ledger[rid] = ("MANUAL", "כלל שיפוט/משמעת — מוצג, לא חוסם אוטומטית")
        else:  # computable אך אין מעריך עדיין
            ledger[rid] = ("NO_EVALUATOR", "computable ללא מעריך — בייצור: fail-closed/בנייה נכשלת")
    # כללי-הנדסה (ENG-*) שאינם במרשם-הקורס — מוערכים בנפרד ומסומנים ככאלה
    for rid in EVAL:
        if rid not in ledger:
            try:
                ledger[rid] = EVAL[rid](ctx)
            except Exception as e:
                ledger[rid] = ("UNKNOWN", f"שגיאת-הערכה: {e}")
    return ledger


def coverage_report(reg, ledger):
    from collections import Counter
    c = Counter(v[0] for v in ledger.values())
    # fail-closed: שער computable שסטטוסו UNKNOWN/NO_EVALUATOR/NEEDS_VISION חוסם ENTRY
    gate_gaps = [r["id"] for r in reg["rules"] if r["gate"]
                 and ledger[r["id"]][0] in ("UNKNOWN", "NO_EVALUATOR", "NEEDS_VISION")
                 and "entry" in r["applies_to"]]
    return c, gate_gaps


def run(ticker, spy_ctx, reg):
    daily = fetch(ticker); weekly = to_weekly(daily)
    ctx = build_context(ticker, daily, weekly, spy_ctx)
    ledger = evaluate(reg, ctx)
    decision, reason = decide(ctx, ledger)
    cov, gaps = coverage_report(reg, ledger)
    return ctx, ledger, decision, reason, cov, gaps


def main():
    tickers = sys.argv[1:] or ["DE", "RKLB"]
    reg = json.load(open(REGISTRY))
    assert len(reg["rules"]) == 192, "reconciliation: registry != 192"
    # שער מגמת-שוק: SPY נקודת-בזמן
    spy = fetch("SPY"); spy_c = [r[4] for r in spy]
    spy_ctx = {"above_200": I.sma(spy_c, 200) is not np.nan and spy_c[-1] > I.sma(spy_c, 200)}
    print(f"# smrtTrade — פנקס-כיסוי T1.4  (cutoff {CUTOFF}, SPY מעל SMA200: {spy_ctx['above_200']})\n")
    for tk in tickers:
        ctx, ledger, decision, reason, cov, gaps = run(tk, spy_ctx, reg)
        locked = LOCKED.get(tk, "—")
        match = "✅ תואם" if _norm(decision) == _norm(locked) else "⚠️ שונה"
        print(f"## {tk}  —  החלטת-הרתמה: **{decision}**   |   נעול 14/07: {locked}   {match}")
        print(f"   מחיר {ctx['price']:.2f} · מגמה שבועית {ctx['w_trend']} · "
              f"SMA50 {ctx['sma50']:.1f} SMA200 {ctx['sma200']:.1f} · "
              f"RSI ש׳{ctx['rsi_w']:.0f}/י׳{ctx['rsi_d']:.0f} · {ctx['pct_from_high']:.0f}% משיא")
        print(f"   נימוק: {reason}")
        print(f"   כיסוי: " + " · ".join(f"{k}={v}" for k, v in sorted(cov.items())))
        print(f"   שערי-כניסה ללא-מעריך (בייצור fail-closed): {len(gaps)}")
        # שערים שנבדקו בפועל (PASS/FAIL) — עיקר ההחלטה
        checked = [(rid, ledger[rid]) for rid in EVAL if ledger[rid][0] in (P, F, "N/A")]
        for rid, (s, d) in checked:
            mark = {"PASS": "✓", "FAIL": "✗", "N/A": "–"}[s]
            print(f"      {mark} {rid}: {d}")
        print()


def _norm(x):
    x = x.replace("→כניסה", "").strip()
    return {"כניסה": "entry", "מעקב": "watch", "הימנעות": "avoid", "נפסל": "reject"}.get(x, x)


if __name__ == "__main__":
    main()
