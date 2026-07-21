"""smrtTrade — בקרת כניסות-אקראי (Monte-Carlo) לבדיקת-סלקטיביות.

השאלה: האם **בחירת-הכניסה** של המנוע (harness.decide → "כניסה") מוסיפה תוחלת מעל
כניסה אקראית מאותו יקום, ב**אותם תאריכים**, דרך **אותו מנוע-יציאה בדיוק**?

שיטה (בקרת-משטר קפדנית):
  1. משחזרים את 76 איתותי-ה-test האמיתיים (≥2025-01-01), עם מנוע-היציאה המתוקן
     (כניסה בפתיחה-הבאה + דגל-מימוש נכון). תוחלת-אמת = E_real.
  2. בונים "בריכת-מועמדים" לכל תאריך-סריקה בטווח-ה-test: כל טיקר עם ≥220 ברים
     שעובר פילטר-סחירות בסיסי (מחיר>5$, מחזור>1M) — **בלי** שער-הכניסה. אלה
     ה"כניסות שיכלו להיבחר אקראית".
  3. Monte-Carlo: בכל הגרלה, כל איתות-אמת מוחלף בטיקר אקראי מבריכת **אותו תאריך**
     (שומר על התפלגות-התאריכים ⇒ מנטרל דריפט-שוק ואשכולות). מריצים דרך אותו
     run_exit, מחשבים תוחלת-ההגרלה. חוזרים DRAWS פעמים ⇒ התפלגות-אקראי.
  4. משווים: E_real מול ההתפלגות (אחוזון, ממוצע-אקראי, CI). זרע-אקראי קבוע.

פרשנות: E_real≈ממוצע-אקראי ⇒ הכניסות לא מוסיפות דבר מעל דריפט-השוק.
E_real גבוה משמעותית ⇒ הבחירה מוסיפה ערך. E_real נמוך ⇒ הבחירה פוגעת.
"""
import json, datetime, sys, os, random, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import harness as H, indicators as I
import numpy as np
random.seed(1234)
REG = json.load(open(os.path.join(HERE, "..", "..", "stock-course-rules.registry.json")))

# יקום זהה ל-calib_big.py
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
 "PLTR SOFI RBLX RIVN LCID COIN MARA RIOT HOOD AFRM UPST SNAP PINS ROKU ZM "
 "DOCU CVNA PTON BYND PLUG CHPT BLNK FSLR ENPH SEDG RUN NET SNOW DDOG U SHOP "
 "SQ PYPL UBER LYFT ABNB DASH TWLO OKTA ZS MDB DKNG PENN CELH WING "
 "F GM NIO XPEV LI FUBO OPEN WISH CLOV SPCE GME AMC BB NOK "
 "SIVB FRC SBNY BBBY WE SI MULN NKLA BBIG ")
UNIV = sorted(set(LARGE.split()))
DE = (0.025, 0.5, 2, 0.5, 0.02)     # פרמטרי-ברירת-מחדל (זהים ל-calib_big)
DRAWS = 2000

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

def run_exit(daily, i0, sup, atr, vw, p):
    """זהה ל-calib_big.sim, כניסה בפתיחה-הבאה. מחזיר R או None."""
    fwd, ll = pc(daily, i0)
    if len(fwd) < 2: return None
    entry = fwd[1][1]; m_start = 2
    sp, sa, rr, sc, tr = p
    istop = (sup - max(sp*entry, sa*atr)) if (sup and sup < entry) else entry*(1-sp) - sa*atr
    risk = entry - istop
    if risk <= 0: return None
    tgt = entry + rr*risk; stop = istop; rem = 1.0; R = 0.0; scaled = False
    for m in range(m_start, len(fwd)):
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

print(f"fetching {len(UNIV)} tickers...", flush=True)
DATA = {}
with ThreadPoolExecutor(max_workers=10) as ex:
    for tk, rows in ex.map(fetch, UNIV + ["SPY"]):
        if rows: DATA[tk] = rows
spy = DATA.pop("SPY"); spy_c = [r[4] for r in spy]; spy_d = [r[0] for r in spy]
def spy_above(cut):
    idx = [i for i, d in enumerate(spy_d) if d <= cut]
    return spy_c[:idx[-1]+1][-1] > float(np.mean(spy_c[:idx[-1]+1][-200:])) if len(idx) >= 200 else None
print(f"got {len(DATA)} stocks", flush=True)

# ── שלב 1: שחזור איתותי-האמת (זהה ל-calib_big) ──
start = datetime.date(2022, 7, 1); end = datetime.date(2026, 2, 20); cur = start; dates = []
while cur <= end: dates.append(cur.isoformat()); cur += datetime.timedelta(days=14)
real = []; open_until = {}
for cut in dates:
    sab = spy_above(cut)
    for tk, daily in DATA.items():
        di = [i for i, r in enumerate(daily) if r[0] <= cut]
        if len(di) < 220: continue
        i0 = di[-1]
        if open_until.get(tk, "") >= cut: continue
        dsl = daily[:i0+1]
        try:
            ctx = H.build_context(tk, dsl, weekly(dsl), {"above_200": sab})
            led = H.evaluate(REG, ctx); dec, _ = H.decide(ctx, led)
        except Exception:
            continue
        if dec.replace("→כניסה", "").strip() == "כניסה":
            real.append((cut, tk, i0, ctx.get("support"), ctx.get("atr_d") or daily[i0][4]*0.03,
                         (ctx.get("vol_ratio5") or 1) < 1))
            open_until[tk] = (datetime.date.fromisoformat(cut) + datetime.timedelta(days=80)).isoformat()
real_test = [s for s in real if s[0] >= "2025-01-01"]
real_R = [run_exit(DATA[s[1]], s[2], s[3], s[4], s[5], DE) for s in real_test]
real_R = [r for r in real_R if r is not None]
E_real = sum(real_R)/len(real_R)
print(f"REAL test signals: n={len(real_R)} · E_real={E_real:+.3f}R · win={sum(1 for r in real_R if r>0)/len(real_R):.0%}", flush=True)

# ── שלב 2: בריכת-מועמדים לכל תאריך-test (פילטר-סחירות בלבד, בלי שער-כניסה) ──
test_dates = sorted(set(s[0] for s in real_test))
POOL = {}   # date -> list of (ticker, i0, support, atr, vw)
SAMPLE_PER_DATE = 80
print(f"building candidate pools for {len(test_dates)} test dates...", flush=True)
for cut in test_dates:
    sab = spy_above(cut)
    eligible = []
    for tk, daily in DATA.items():
        di = [i for i, r in enumerate(daily) if r[0] <= cut]
        if len(di) < 220: continue
        i0 = di[-1]; price = daily[i0][4]
        volavg = float(np.mean([daily[j][5] for j in di[-20:]]))
        if price > 5 and volavg > 1e6:                    # פילטר-סחירות בסיסי (א-4/א-5)
            eligible.append((tk, i0))
    random.shuffle(eligible)
    pool = []
    for tk, i0 in eligible[:SAMPLE_PER_DATE]:
        dsl = DATA[tk][:i0+1]
        try:
            ctx = H.build_context(tk, dsl, weekly(dsl), {"above_200": sab})
        except Exception:
            continue
        pool.append((tk, i0, ctx.get("support"), ctx.get("atr_d") or DATA[tk][i0][4]*0.03,
                     (ctx.get("vol_ratio5") or 1) < 1))
    POOL[cut] = pool
    print(f"  {cut}: {len(eligible)} eligible · pool {len(pool)}", flush=True)

# ── שלב 3: Monte-Carlo — לכל איתות-אמת, טיקר אקראי מאותו תאריך ──
draw_means = []
for d in range(DRAWS):
    rs = []
    for s in real_test:
        pool = POOL.get(s[0]) or []
        if not pool: continue
        c = random.choice(pool)
        r = run_exit(DATA[c[0]], c[1], c[2], c[3], c[4], DE)
        if r is not None: rs.append(r)
    if rs: draw_means.append(sum(rs)/len(rs))
draw_means.sort()
n = len(draw_means)
mean_rand = sum(draw_means)/n
lo, hi = draw_means[int(0.025*n)], draw_means[int(0.975*n)]
pctile = sum(1 for x in draw_means if x < E_real)/n            # אחוזון של E_real בהתפלגות-האקראי
p_rand_ge_real = sum(1 for x in draw_means if x >= E_real)/n

print("\n" + "="*64)
print(f"MONTE-CARLO random-entry baseline ({DRAWS} draws, seed 1234)")
print("="*64)
print(f"E_real (engine picks)     : {E_real:+.3f}R  (n={len(real_R)})")
print(f"random-entry mean         : {mean_rand:+.3f}R")
print(f"random 95% CI             : [{lo:+.3f}, {hi:+.3f}]R")
print(f"E_real percentile in random: {pctile:.0%}")
print(f"P(random ≥ E_real)        : {p_rand_ge_real:.0%}")
print("-"*64)
if E_real > hi:
    print("→ הכניסות של המנוע מעל בקרת-האקראי (מחוץ ל-CI מלמעלה): בחירה מוסיפה ערך.")
elif E_real < lo:
    print("→ הכניסות של המנוע מתחת לבקרת-האקראי: הבחירה פוגעת מול אקראי.")
else:
    print("→ E_real בתוך ה-CI של האקראי: בחירת-הכניסה אינה נבדלת מאקראי/דריפט-שוק.")
