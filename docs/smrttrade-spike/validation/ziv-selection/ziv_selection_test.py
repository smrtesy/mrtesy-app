"""בדיקה #1 — סלקטיביות: כניסות-זיו מול כניסות-המנוע מול אקראי.

השאלה: האם בחירת-הכניסה של זיו (קריאת-גרף אנושית) מוסיפה תוחלת מעל המנוע ומעל
אקראי — דרך **אותו מנוע-יציאה בדיוק**, על **אותם תאריכים**?

קלט: פסקי-זיו מ-
  - goldenset/ziv_verdicts_<YYYY-MM-DD>.json   (5 סרטוני ינו-פבר26 + 2023)
  - ziv-selection/verdicts/ziv_<YYYY-MM-DD>_<id>.json  (9 סרטונים בשלים)
"כניסת-זיו פעילה" = label ∈ {כניסה, מעקב·אזור-כניסה}. תאריך-ההחלטה = תאריך-הסרטון.
כניסה בפועל בפתיחת-היום-הבא. מנוע-יציאה + פרמטרים זהים ל-calib/montecarlo.

שלוש תוחלות על אותם תאריכים:
  ZIV    — הטיקרים שזיו סימן פעיל-ללונג.
  ENGINE — מה שהמנוע (harness.decide) פלט "כניסה" באותם תאריכים (יקום רחב).
  RANDOM — טיקר אקראי נזיל מאותו תאריך (Monte-Carlo, בקרת-משטר).
ובנוסף head-to-head: על הטיקרים של זיו, מה המנוע החליט?
"""
import json, datetime, sys, os, glob, random, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE = os.path.join(HERE, "..", "..")
sys.path.insert(0, SPIKE)
import harness as H, indicators as I
import numpy as np
random.seed(1234)
REG = json.load(open(os.path.join(SPIKE, "..", "stock-course-rules.registry.json")))
DE = (0.025, 0.5, 2, 0.5, 0.02)
ACTIONABLE = {"כניסה", "מעקב·אזור-כניסה"}
RESOLVED_CUTOFF = "2026-05-27"     # תאריך-סרטון מאוחר מזה = פחות מ~8ש׳ קדימה → מוחרג

# יקום-אקראי רחב (זהה ל-calib_big/montecarlo)
LARGE = ("AAPL MSFT NVDA GOOGL GOOG AMZN META TSLA AVGO ORCL CRM ADBE AMD CSCO ACN "
 "INTC IBM QCOM TXN NOW INTU AMAT MU ADI LRCX KLAC SNPS CDNS PANW CRWD FTNT "
 "ANET MSI APH GLW HPQ HPE DELL WDC STX NTAP ON MCHP MPWR SWKS TER ZBRA "
 "JPM BAC WFC C GS MS BLK SPGI AXP SCHW USB PNC TFC COF BK CB MMC PGR AIG "
 "MET PRU ALL TRV AFL CME ICE MCO AON UNH JNJ LLY ABBV MRK PFE TMO ABT DHR BMY "
 "AMGN GILD CVS CI ELV HUM CNC ISRG MDT SYK BDX BSX VRTX REGN ZTS BIIB IQV IDXX A DXCM MRNA "
 "WMT PG KO PEP COST MCD HD LOW NKE SBUX TGT DIS CMCSA TJX BKNG MDLZ CL MO PM KMB GIS KHC "
 "HSY SYY KR DG DLTR ROST YUM MAR HLT CMG ORLY AZO XOM CVX COP SLB EOG MPC PSX VLO OXY WMB "
 "KMI HES DVN HAL BKR FANG CAT DE BA HON GE LMT RTX UPS UNP MMM EMR ETN ITW CSX NSC FDX GD NOC "
 "WM PH ROP CARR OTIS PCAR CMI PWR FAST ODFL LUV DAL UAL LIN APD SHW ECL FCX NEM NUE DOW DD PPG "
 "VMC MLM CTVA NEE DUK SO D AEP EXC SRE XEL PEG ED WEC ES AMT PLD CCI EQIX PSA O SPG WELL DLR "
 "VICI AVB EQR T VZ TMUS CHTR PLTR SOFI RBLX RIVN LCID COIN MARA RIOT HOOD AFRM UPST SNAP PINS "
 "ROKU ZM DOCU CVNA PTON BYND PLUG CHPT BLNK FSLR ENPH SEDG RUN NET SNOW DDOG U SHOP SQ PYPL "
 "UBER LYFT ABNB DASH TWLO OKTA ZS MDB DKNG PENN CELH WING F GM NIO XPEV LI FUBO OPEN OKLO").split()

def load_verdicts():
    """מחזיר רשימת (date, ticker, label, quote) לכל פסק פעיל-ללונג עם טיקר תקף."""
    out = []
    files = glob.glob(os.path.join(SPIKE, "goldenset", "ziv_verdicts_*.json")) + \
            glob.glob(os.path.join(HERE, "verdicts", "ziv_*.json"))
    for fp in files:
        base = os.path.basename(fp)
        # חילוץ תאריך YYYY-MM-DD מהשם
        import re
        m = re.search(r"(\d{4}-\d{2}-\d{2})", base)
        if not m: continue
        date = m.group(1)
        try:
            arr = json.load(open(fp))
        except Exception:
            continue
        for o in arr:
            tk = o.get("ticker") or o.get("ticker_guess")
            lbl = o.get("label", "")
            if tk and lbl in ACTIONABLE:
                out.append((date, tk.upper().strip(), lbl, o.get("quote", ""), base))
    return out

def fetch(tk):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?range=5y&interval=1d"
    try:
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

def pc(daily, i0, k=5):
    dh = [r[2] for r in daily]; dl = [r[3] for r in daily]; _, lows = I.swings(dh, dl, k)
    cl = sorted((p+k, v) for p, v in lows); fwd = daily[i0:]; out = []; ptr = 0; cur = None
    for j in range(i0, len(daily)):
        while ptr < len(cl) and cl[ptr][0] <= j: cur = cl[ptr][1]; ptr += 1
        out.append(cur)
    return fwd, out

def run_exit(daily, i0, sup, atr, vw, p=DE):
    fwd, ll = pc(daily, i0)
    if len(fwd) < 2: return None
    entry = fwd[1][1]                       # פתיחה-הבאה
    sp, sa, rr, sc, tr = p
    istop = (sup - max(sp*entry, sa*atr)) if (sup and sup < entry) else entry*(1-sp) - sa*atr
    risk = entry - istop
    if risk <= 0: return None
    tgt = entry + rr*risk; stop = istop; rem = 1.0; R = 0.0; scaled = False
    for m in range(2, len(fwd)):
        o, h, l, c = fwd[m][1], fwd[m][2], fwd[m][3], fwd[m][4]; lo = ll[m]
        if o <= stop: R += rem*(o-entry)/risk; rem = 0; break
        if l <= stop: R += rem*(stop-entry)/risk; rem = 0; break
        if not scaled and h >= tgt:
            f = (sc if vw else 0.75); R += f*(tgt-entry)/risk; rem -= f; stop = max(stop, entry); scaled = True
            if rem <= 0.001: break
            continue
        if lo and c < lo and stop < lo: R += rem*(c-entry)/risk; rem = 0; break
        if lo and c > lo: stop = max(stop, lo*(1-tr))
    if rem > 0: R += rem*(fwd[-1][4]-entry)/risk
    return R - 0.30*entry/risk/100

def ctx_at(tk, cut, sab=None):
    """build_context של טיקר בתאריך (נקודת-בזמן)."""
    daily = DATA.get(tk)
    if not daily: return None, None
    di = [i for i, r in enumerate(daily) if r[0] <= cut]
    if len(di) < 220: return None, None
    i0 = di[-1]; dsl = daily[:i0+1]
    try:
        ctx = H.build_context(tk, dsl, weekly(dsl), {"above_200": sab})
    except Exception:
        return None, i0
    return ctx, i0

def stats(rs):
    rs = [r for r in rs if r is not None]
    n = len(rs)
    if not n: return (0, 0, 0, 0, 0)
    m = sum(rs)/n; sd = (sum((r-m)**2 for r in rs)/(n-1))**0.5 if n > 1 else 0
    return (m, sum(rs), n, sum(1 for r in rs if r > 0)/n, m/(sd/n**0.5) if sd else 0)

# ── טעינה + fetch ──
verdicts = [v for v in load_verdicts() if v[0] <= RESOLVED_CUTOFF]
ziv_tickers = sorted(set(v[1] for v in verdicts))
print(f"Ziv actionable-long verdicts (resolved ≤{RESOLVED_CUTOFF}): {len(verdicts)} · unique tickers {len(ziv_tickers)}", flush=True)
allt = sorted(set(LARGE) | set(ziv_tickers))
print(f"fetching {len(allt)} tickers (+SPY)...", flush=True)
DATA = {}
with ThreadPoolExecutor(max_workers=10) as ex:
    for tk, rows in ex.map(fetch, allt + ["SPY"]):
        if rows: DATA[tk] = rows
spy = DATA.pop("SPY", None); spy_c = [r[4] for r in spy] if spy else []; spy_d = [r[0] for r in spy] if spy else []
def spy_above(cut):
    if not spy_c: return None
    idx = [i for i, d in enumerate(spy_d) if d <= cut]
    return spy_c[:idx[-1]+1][-1] > float(np.mean(spy_c[:idx[-1]+1][-200:])) if len(idx) >= 200 else None
missing = [t for t in ziv_tickers if t not in DATA]
print(f"got {len(DATA)} stocks · Ziv tickers missing data: {missing}", flush=True)

# ── ZIV: כל פסק-פעיל דרך מנוע-היציאה ──
ziv_R = []; ziv_dates = []
for date, tk, lbl, q, src in verdicts:
    ctx, i0 = ctx_at(tk, date, spy_above(date))
    if ctx is None or i0 is None: continue
    r = run_exit(DATA[tk], i0, ctx.get("support"), ctx.get("atr_d") or DATA[tk][i0][4]*0.03, (ctx.get("vol_ratio5") or 1) < 1)
    if r is not None:
        ziv_R.append(r); ziv_dates.append(date)
zm, zt, zn, zw, zts = stats(ziv_R)

# ── ENGINE: מה המנוע פלט "כניסה" באותם תאריכי-סרטון (יקום רחב) ──
eng_R = []
for date in sorted(set(ziv_dates)):
    sab = spy_above(date)
    for tk in LARGE:
        ctx, i0 = ctx_at(tk, date, sab)
        if ctx is None: continue
        led = H.evaluate(REG, ctx); dec, _ = H.decide(ctx, led)
        if dec.replace("→כניסה", "").strip() == "כניסה":
            r = run_exit(DATA[tk], i0, ctx.get("support"), ctx.get("atr_d") or DATA[tk][i0][4]*0.03, (ctx.get("vol_ratio5") or 1) < 1)
            if r is not None: eng_R.append(r)
em, et, en, ew, ets = stats(eng_R)

# ── HEAD-TO-HEAD: על הטיקרים של זיו, מה המנוע החליט? ──
from collections import Counter
h2h = Counter()
for date, tk, lbl, q, src in verdicts:
    ctx, i0 = ctx_at(tk, date, spy_above(date))
    if ctx is None: h2h["no-data/short"] += 1; continue
    led = H.evaluate(REG, ctx); dec, _ = H.decide(ctx, led)
    h2h[dec.replace("→כניסה", "").strip()] += 1

# ── RANDOM: בקרת-משטר. מחשבים R לכל מועמד-בריכה פעם אחת, ואז דוגמים (מהיר) ──
pool_R = {}      # date -> list of R (deterministic per candidate)
for date in sorted(set(ziv_dates)):
    sab = spy_above(date); elig = []
    for tk in LARGE:
        daily = DATA.get(tk)
        if not daily: continue
        di = [i for i, r in enumerate(daily) if r[0] <= date]
        if len(di) < 220: continue
        i0 = di[-1]
        if daily[i0][4] > 5 and float(np.mean([daily[j][5] for j in di[-20:]])) > 1e6:
            elig.append((tk, i0))
    random.shuffle(elig)
    rs = []
    for tk, i0 in elig[:80]:                         # precompute R once per candidate
        ctx, _ = ctx_at(tk, date, sab)
        if ctx is None: continue
        r = run_exit(DATA[tk], i0, ctx.get("support"), ctx.get("atr_d") or DATA[tk][i0][4]*0.03, (ctx.get("vol_ratio5") or 1) < 1)
        if r is not None: rs.append(r)
    pool_R[date] = rs
    print(f"  pool {date}: {len(rs)} candidate-R", flush=True)
draw_means = []
for d in range(2000):
    rs = [random.choice(pool_R[date]) for date in ziv_dates if pool_R.get(date)]
    if rs: draw_means.append(sum(rs)/len(rs))
draw_means.sort(); nR = len(draw_means); rmean = sum(draw_means)/nR
rlo, rhi = draw_means[int(0.025*nR)], draw_means[int(0.975*nR)]
z_pct = sum(1 for x in draw_means if x < zm)/nR

print("\n" + "="*66)
print("בדיקה #1 — סלקטיביות: ZIV מול ENGINE מול RANDOM (מנוע-יציאה זהה)")
print("="*66)
print(f"ZIV    picks : {zm:+.3f}R · total {zt:+.1f}R · n={zn} · win={zw:.0%} · t={zts:.2f}")
print(f"ENGINE picks : {em:+.3f}R · total {et:+.1f}R · n={en} · win={ew:.0%} · t={ets:.2f}  (אותם תאריכים)")
print(f"RANDOM mean  : {rmean:+.3f}R · 95%CI [{rlo:+.3f}, {rhi:+.3f}] (2000 הגרלות)")
print(f"→ ZIV באחוזון {z_pct:.0%} של האקראי")
print(f"\nHEAD-TO-HEAD (מה המנוע החליט על {len(verdicts)} טיקרים שזיו סימן פעיל-ללונג):")
for k, v in h2h.most_common(): print(f"   {k}: {v}")
