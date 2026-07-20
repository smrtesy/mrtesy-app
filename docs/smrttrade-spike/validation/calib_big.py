"""smrtTrade — כיול מנוע-היציאה מחוץ-למדגם (OOS) על יקום רחב.

מטרה: לקבוע אם לליבת-הכללים (176 כללי-קורס, אחרי הפרדת מסחר-על-דוח) יש
תוחלת-חיובית אמינה — לא ארטיפקט של הטיית-שרידות או מדגם קטן.

שיטה:
  1. יקום רחב (~300 שמות על פני סקטורים) + זריעת כשלונות/מחיקות ידועות
     (נגד survivorship). נתונים: Yahoo chart API (חינם), OHLCV יומי 5 שנים.
  2. סריקה נקודת-בזמן כל שבועיים (2022-07 → 2026-02). בכל תאריך, מנוע-ההחלטה
     הדטרמיניסטי (harness.decide) פולט "כניסה"/"מעקב"/"הימנעות". רק "כניסה" נכנס.
  3. פיצול-זמן: train = איתותים לפני 2025-01-01 · test = מ-2025-01-01 והלאה.
     ה-test **נעול** — לא משתתף בבחירת-הפרמטרים.
  4. גריד של 32 צירופי פרמטרי-יציאה מכויל על train בלבד (מקסום תוחלת).
     הפרמטרים הנבחרים מורצים ריצה **אחת** על ה-test המוסתר.
  5. מדווח גם ברירות-מחדל (לא-מכוילות) על ה-test כבקרה נגד overfitting.

מנוע-היציאה (sim) הוא שיקוף נאמן של exit_engine.py (מומנטום כבוי — report-scope):
  גאפ→סטופ-קשיח→מימוש 2R (50%/75% אם מחזור-חלש)+BE→יציאה-מבנית→סטופ-עוקב.
  עלות/החלקה 0.30% לעסקה. אין סטופ-זמן — פוזיציה רצה עד שכלל מוציא או סוף-הדאטה.

הרצה:  python3 calib_big.py    (מהתיקייה הזו; מוסיף ../ ל-sys.path עבור harness)
"""
import json, datetime, sys, os, itertools
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import harness as H, indicators as I
import numpy as np
REG = json.load(open(os.path.join(HERE, "..", "..", "stock-course-rules.registry.json")))

# ── יקום רחב: ~300 שמות על פני סקטורים (לא מסונן-מנצחים) ──
LARGE = ("AAPL MSFT NVDA GOOGL GOOG AMZN META TSLA AVGO ORCL CRM ADBE AMD CSCO ACN "
 "INTC IBM QCOM TXN NOW INTU AMAT MU ADI LRCX KLAC SNPS CDNS PANW CRWD FTNT "
 "ANET MSI APH GLW HPQ HPE DELL WDC STX NTAP ON MCHP MPWR SWKS TER ZBRA "
 "JPM BAC WFC C GS MS BLK SPGI AXP SCHW USB PNC TFC COF BK CB MMC PGR AIG "
 "MET PRU ALL TRV AFL CME ICE MCO AON "
 "UNH JNJ LLY ABBV MRK PFE TMO ABT DHR BMY AMGN GILD CVS CI ELV HUM CNC "
 "ISRG MDT SYK BDX BSX VRTX REGN ZTS BIIB IQV IDXX A DXCM MRNA "
 "WMT PG KO PEP COST MCD HD LOW NKE SBUX TGT DIS CMCSA TJX BKNG MDLZ CL "
 "MO PM KMB GIS KHC HSY SYY KR DG DLTR ROST YUM MAR HLT CMG ORLY AZO "
 "XOM CVX COP SLB EOG MPC PSX VLO OXY WMB KMI HES DVN HAL BKR FANG "
 "CAT DE BA HON GE LMT RTX UPS UNP MMM EMR ETN ITW CSX NSC FDX GD NOC "
 "WM PH ROP CARR OTIS PCAR CMI PWR FAST ODFL LUV DAL UAL "
 "LIN APD SHW ECL FCX NEM NUE DOW DD PPG VMC MLM CTVA "
 "NEE DUK SO D AEP EXC SRE XEL PEG ED WEC ES "
 "AMT PLD CCI EQIX PSA O SPG WELL DLR VICI AVB EQR "
 "T VZ TMUS CHTR "
 # ── מומנטום/צמיחה/ספקולטיבי (הרבה מהם התרסקו 2022) ──
 "PLTR SOFI RBLX RIVN LCID COIN MARA RIOT HOOD AFRM UPST SNAP PINS ROKU ZM "
 "DOCU CVNA PTON BYND PLUG CHPT BLNK FSLR ENPH SEDG RUN NET SNOW DDOG U SHOP "
 "SQ PYPL UBER LYFT ABNB DASH TWLO OKTA ZS MDB DKNG PENN CELH WING "
 "F GM NIO XPEV LI FUBO OPEN WISH CLOV SPCE GME AMC BB NOK "
 # ── כשלונות/מחיקות ידועות 2022-2025 (זריעה נגד survivorship) ──
 "SIVB FRC SBNY BBBY WE SI MULN NKLA BBIG ")
UNIV = sorted(set(LARGE.split()))

def fetch(tk):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?range=5y&interval=1d"
    try:
        import urllib.request
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20))["chart"]["result"][0]
    except Exception:
        return tk, None
    ts = d.get("timestamp"); q = d["indicators"]["quote"][0]
    if not ts: return tk, None
    rows = []
    for i, t in enumerate(ts):
        o, h, l, c, v = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
        if None in (o, h, l, c): continue
        rows.append((datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"), o, h, l, c, v or 0))
    return tk, (rows if len(rows) >= 260 else None)

def weekly(daily):
    b = {}
    for dt, o, h, l, c, v in daily:
        y, w, _ = datetime.date.fromisoformat(dt).isocalendar(); k = (y, w)
        x = b.setdefault(k, [dt, o, h, l, c, v]); x[2] = max(x[2], h); x[3] = min(x[3], l); x[4] = c; x[5] += v; x[0] = dt
    return [tuple(b[k]) for k in sorted(b)]

SEEDS = "SIVB FRC SBNY BBBY WE SI MULN NKLA BBIG".split()   # כשלונות/מחיקות שזרענו
print(f"fetching {len(UNIV)} tickers...", flush=True)
DATA = {}; dropped = []
with ThreadPoolExecutor(max_workers=10) as ex:
    for tk, rows in ex.map(fetch, UNIV + ["SPY"]):
        if rows: DATA[tk] = rows
        else: dropped.append(tk)
# retry שני לנשמטים (כשל-endpoint חולף, לא רק מחיקות)
if dropped:
    retry = list(dropped); dropped = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        for tk, rows in ex.map(fetch, retry):
            if rows: DATA[tk] = rows
            else: dropped.append(tk)
# שקיפות על היקום האפקטיבי (תיקון ממצא-ביקורת F/#2/#5)
seeds_in = [s for s in SEEDS if s in DATA]
print(f"dropped/no-data ({len(dropped)}): {sorted(dropped)}", flush=True)
print(f"seeded-failures that actually loaded ({len(seeds_in)}/{len(SEEDS)}): {seeds_in}", flush=True)
spy = DATA.pop("SPY"); spy_c = [r[4] for r in spy]; spy_d = [r[0] for r in spy]
def spy_above(cut):
    idx = [i for i, d in enumerate(spy_d) if d <= cut]
    return spy_c[:idx[-1]+1][-1] > float(np.mean(spy_c[:idx[-1]+1][-200:])) if len(idx) >= 200 else None
print(f"got {len(DATA)} stocks; scanning...", flush=True)

start = datetime.date(2022, 7, 1); end = datetime.date(2026, 2, 20); cur = start; dates = []
while cur <= end: dates.append(cur.isoformat()); cur += datetime.timedelta(days=14)
signals = []; open_until = {}
for cut in dates:
    sab = spy_above(cut)
    for tk, daily in DATA.items():
        di = [i for i, r in enumerate(daily) if r[0] <= cut]
        if len(di) < 220: continue
        i0 = di[-1]
        if open_until.get(tk, "") >= cut: continue          # פוזיציה אחת פר-מניה בו-זמנית
        dsl = daily[:i0+1]                                   # נקודת-בזמן: רק עד cut, אין הצצה קדימה
        try:
            ctx = H.build_context(tk, dsl, weekly(dsl), {"above_200": sab})
            led = H.evaluate(REG, ctx); dec, _ = H.decide(ctx, led)
        except Exception:
            continue
        if dec.replace("→כניסה", "").strip() == "כניסה":
            signals.append((cut, tk, i0, ctx.get("support"), ctx.get("atr_d") or daily[i0][4]*0.03,
                            (ctx.get("vol_ratio5") or 1) < 1, ctx))   # ctx נשמר לאבחון
            open_until[tk] = (datetime.date.fromisoformat(cut) + datetime.timedelta(days=80)).isoformat()
print(f"signals: {len(signals)}", flush=True)

def pc(daily, i0, k=5):
    """שפל-ציר-אחרון מאושר לכל בר קדימה. הציר בעמדה p מאושר רק ב-p+k (fractal),
    לכן אין הצצה קדימה למרות ש-swings מחושב על כל הסדרה (ערכי-הציר תלויים רק ב-[p-k,p+k])."""
    dh = [r[2] for r in daily]; dl = [r[3] for r in daily]; _, lows = I.swings(dh, dl, k)
    cl = sorted((p+k, v) for p, v in lows); fwd = daily[i0:]; out = []; ptr = 0; cur = None
    for j in range(i0, len(daily)):
        while ptr < len(cl) and cl[ptr][0] <= j: cur = cl[ptr][1]; ptr += 1
        out.append(cur)
    return fwd, out
PC = [pc(DATA[s[1]], s[2]) for s in signals]

# ENTRY_NEXT_OPEN: ברירת-המחדל הריאליסטית (תיקון ממצא-ביקורת #3). ההחלטה מתקבלת
# בסגירת יום-האיתות; הכניסה בפועל בפתיחת-היום-הבא (fwd[1] open). כניסה-בסגירה
# (ההנחה האופטימית הישנה) זמינה ל-A/B ע"י ENTRY_NEXT_OPEN=False.
ENTRY_NEXT_OPEN = True

def sim(k, p):
    s = signals[k]; daily = DATA[s[1]]; i0 = s[2]; sup = s[3]; atr = s[4]; vw = s[5]
    fwd, ll = PC[k]
    if ENTRY_NEXT_OPEN:
        if len(fwd) < 2: return None
        entry = fwd[1][1]; m_start = 2          # נכנסים בפתיחת-הבא; יציאות מהיום שאחריו
    else:
        entry = daily[i0][4]; m_start = 1       # כניסה-בסגירה (הנחה אופטימית ישנה)
    sp, sa, rr, sc, tr = p
    istop = (sup - max(sp*entry, sa*atr)) if (sup and sup < entry) else entry*(1-sp) - sa*atr
    risk = entry - istop
    if risk <= 0: return None
    tgt = entry + rr*risk; stop = istop; rem = 1.0; R = 0.0; scaled = False
    for m in range(m_start, len(fwd)):
        o, h, l, c = fwd[m][1], fwd[m][2], fwd[m][3], fwd[m][4]; lo = ll[m]
        if o <= stop: R += rem*(o-entry)/risk; rem = 0; break               # גאפ (יא-16)
        if l <= stop: R += rem*(stop-entry)/risk; rem = 0; break            # סטופ (יא-10)
        if not scaled and h >= tgt:                                          # מימוש 2R (יא-5)
            # יא-5: 75% אם המחזור לא-אישר (vw=False), 50%/פרמטר אם המחזור בריא-דועך
            # (vw=True). תיקון ממצא-ביקורת #1 — הדגל היה הפוך.
            f = (sc if vw else 0.75); R += f*(tgt-entry)/risk; rem -= f; stop = max(stop, entry); scaled = True
            if rem <= 0.001: break
            continue
        if lo and c < lo and stop < lo: R += rem*(c-entry)/risk; rem = 0; break   # מבני (יא-7)
        if lo and c > lo: stop = max(stop, lo*(1-tr))                             # סטופ-עוקב (יא-1)
    if rem > 0: R += rem*(fwd[-1][4]-entry)/risk                                  # סוף-דאטה
    return R - 0.30*entry/risk/100                                                # עלות/החלקה

def exp(idxs, p):
    rs = [sim(k, p) for k in idxs]; rs = [r for r in rs if r is not None]
    return (sum(rs)/len(rs), sum(rs), len(rs)) if rs else (None, 0, 0)
def winrate(idxs, p):
    rs = [sim(k, p) for k in idxs]; rs = [r for r in rs if r is not None]
    return (sum(1 for r in rs if r > 0)/len(rs)) if rs else 0

def tstat(idxs, p):
    """תוחלת, סטיית-תקן, וסטטיסטיקת-t מול אפס (מדד-מובהקות גס; iid — ראה הערת-אשכול)."""
    rs = [sim(k, p) for k in idxs]; rs = [r for r in rs if r is not None]
    n = len(rs)
    if n < 2: return (0, 0, 0, n)
    m = sum(rs)/n; sd = (sum((r-m)**2 for r in rs)/(n-1))**0.5
    return (m, sd, m/(sd/n**0.5) if sd else 0, n)

tr = [k for k, s in enumerate(signals) if s[0] < "2025-01-01"]
te = [k for k, s in enumerate(signals) if s[0] >= "2025-01-01"]
print(f"train {len(tr)} · test {len(te)}  ·  ENTRY_NEXT_OPEN={ENTRY_NEXT_OPEN}", flush=True)
grid = list(itertools.product([0.02, 0.03], [0.0, 0.5], [2, 3], [0.5, 1.0], [0.02, 0.03]))
best = None
for p in grid:
    e, t, n = exp(tr, p)
    if e is not None and (best is None or e > best[1]): best = (p, e, n)
p = best[0]
print(f"BEST-TRAIN: stop%={p[0]} atr={p[1]} rr={p[2]} scale={p[3]} trail={p[4]} → {best[1]:+.3f}R (n={best[2]})")
tee, tet, ten = exp(te, p)
print(f">>> TEST(held-out): {tee:+.3f}R/trade · total {tet:+.1f}R · n={ten} · win={winrate(te, p):.0%} <<<")
de = (0.025, 0.5, 2, 0.5, 0.02); dee, det, den = exp(te, de)
m, sd, t, n = tstat(te, de)
print(f"default-params on TEST: {dee:+.3f}R · total {det:+.1f}R · win={winrate(te, de):.0%} · std={sd:.2f} · t={t:.2f} (מול אפס)")

# ── פירוק-אבחון על ה-test (ברירות-מחדל) ──
rs = [sim(k, de) for k in te]; rs = [r for r in rs if r is not None]
wins = [r for r in rs if r > 0]; losses = [r for r in rs if r <= 0]
aw = sum(wins)/len(wins) if wins else 0; al = sum(losses)/len(losses) if losses else 0
print(f"\nDECOMP(test,default): n={len(rs)} · avg-win={aw:+.2f}R · avg-loss={al:+.2f}R · win%={len(wins)/len(rs):.0%}")
big = sorted(rs, reverse=True)[:5]
print(f"  top-5 trades = {[round(x,1) for x in big]}R  (sum {sum(big):+.1f} of total {sum(rs):+.1f})")
print(f"  without top-5: {(sum(rs)-sum(big))/(len(rs)-5):+.3f}R/trade")

# ── בדיקת-סלקטיביות: האם החמרת-כניסה על תת-קבוצה מחזירה אדג'? (ctx נשמר בסיגנל) ──
def ctx_of(k): return signals[k][6]
print("\nSUBSET(test,default):")
for name, fn in [
    ("above_200(SPY)", lambda k: ctx_of(k).get("spy_above_200") is True),
    ("weekly-up",      lambda k: ctx_of(k).get("w_trend") == "up"),
    ("R:R≥3",          lambda k: (ctx_of(k).get("rr_setup") or 0) >= 3),
    ("not-overbought", lambda k: (ctx_of(k).get("rsi_w") or 0) < 70),
    ("vol-declining",  lambda k: ctx_of(k).get("pullback_vol_declining")),
]:
    ks = [k for k in te if fn(k)]
    if ks:
        e, t, n = exp(ks, de); print(f"  {name:16s}: {e:+.3f}R · n={n} · win={winrate(ks, de):.0%}")
    else:
        print(f"  {name:16s}: (אין עסקאות בתת-הקבוצה)")

# ── A/B הנחת-הכניסה (תיקון ממצא-ביקורת #3): כניסה-בסגירה מול פתיחה-הבאה ──
print("\nENTRY A/B (test, default-params):")
for mode in (False, True):
    ENTRY_NEXT_OPEN = mode
    m, sd, t, n = tstat(te, de)
    print(f"  {'next-open' if mode else 'close-of-decision-day'}: {m:+.3f}R · n={n} · t={t:.2f}")
ENTRY_NEXT_OPEN = True

# ── הערת-תלות: אשכולות-תאריך (n אפקטיבי < n) ──
from collections import Counter
byday = Counter(signals[k][0] for k in te)
top = byday.most_common(3)
print(f"\nCLUSTER: {len(byday)} תאריכי-כניסה ל-{len(te)} עסקאות; הגדולים: {top}")
