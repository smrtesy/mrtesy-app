import json, datetime, sys, urllib.request, time
sys.path.insert(0,"/home/user/mrtesy-app/docs/smrttrade-spike")
import harness as H, indicators as I, levels as L
import numpy as np
REG=json.load(open("/home/user/mrtesy-app/docs/stock-course-rules.registry.json"))
# יוניברס מגוון שכולל בכוונה הרבה מניות שקרסו (הפחתת הטיית-מנצחים)
UNIV=("AAPL MSFT NVDA GOOGL AMZN META TSLA AMD AVGO NFLX ORCL CRM ADBE QCOM INTC MU "
 "JPM BAC WFC C GS MS V MA AXP "
 "XOM CVX COP SLB OXY "
 "JNJ PFE MRK ABBV UNH LLY BMY CVS "
 "WMT KO PEP PG MCD COST TGT "
 "CAT DE BA GE HON LMT UPS "
 "DIS T VZ CMCSA NKE SBUX "
 # בלוק high-beta / hype-שקרס:
 "PLTR SOFI RBLX RIVN LCID NKLA COIN MARA RIOT HUT SQ PYPL SHOP U PATH AI SOUN IONQ RGTI QS "
 "PTON BYND HOOD AFRM UPST DKNG SNAP PINS ROKU ZM DOCU TDOC CVNA W FSLY NET DDOG SNOW PLUG CHPT "
 "SPCE ENPH FCEL RUN CRWD ABNB UBER LYFT F GM").split()
STOP=0.08; TARGET=0.16; COST=0.30   # עלות/החלקה ~0.3% הלוך-ושוב

def fetch_full(tk):
    url=f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?range=5y&interval=1d"
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
    d=json.load(urllib.request.urlopen(req,timeout=25))["chart"]["result"][0]
    ts=d["timestamp"]; q=d["indicators"]["quote"][0]; rows=[]
    for i,t in enumerate(ts):
        o,h,l,c,v=q["open"][i],q["high"][i],q["low"][i],q["close"][i],q["volume"][i]
        if None in (o,h,l,c): continue
        rows.append((datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"),o,h,l,c,v or 0))
    return rows
def weekly(daily):
    b={}
    for dt,o,h,l,c,v in daily:
        y,w,_=datetime.date.fromisoformat(dt).isocalendar(); k=(y,w)
        x=b.setdefault(k,[dt,o,h,l,c,v]); x[2]=max(x[2],h);x[3]=min(x[3],l);x[4]=c;x[5]+=v;x[0]=dt
    return [tuple(b[k]) for k in sorted(b)]

print(f"fetching {len(UNIV)} names...",flush=True)
DATA={}; miss=[]
for tk in UNIV+["SPY"]:
    try: DATA[tk]=fetch_full(tk)
    except Exception: miss.append(tk)
spy=DATA.pop("SPY",None); spy_c=[r[4] for r in spy] if spy else []; spy_d=[r[0] for r in spy] if spy else []
def spy_above(cut):
    idx=[i for i,d in enumerate(spy_d) if d<=cut]
    if len(idx)<200: return None
    seg=spy_c[:idx[-1]+1]; return seg[-1]>float(np.mean(seg[-200:]))
print(f"got {len(DATA)} | missing {len(miss)}: {miss[:10]}",flush=True)

start=datetime.date(2023,6,2); end=datetime.date(2026,2,20); cur=start; dates=[]
while cur<=end: dates.append(cur.isoformat()); cur+=datetime.timedelta(days=14)
def sim(daily,i0):
    entry=daily[i0][4]; stop=entry*(1-STOP); tgt=entry*(1+TARGET); e=min(i0+40,len(daily)-1)
    for j in range(i0+1,e+1):
        if daily[j][3]<=stop: return -STOP*100-COST
        if daily[j][2]>=tgt: return TARGET*100-COST
    return (daily[e][4]/entry-1)*100-COST
trades=[]; open_until={}
for cut in dates:
    sab=spy_above(cut)
    for tk,daily in DATA.items():
        di=[i for i,r in enumerate(daily) if r[0]<=cut]
        if len(di)<220: continue
        i0=di[-1]
        if open_until.get(tk,"")>=cut: continue
        dsl=daily[:i0+1]
        try:
            ctx=H.build_context(tk,dsl,weekly(dsl),{"above_200":sab})
            led=H.evaluate(REG,ctx); dec,_=H.decide(ctx,led)
        except Exception: continue
        if dec.replace("→כניסה","").strip()=="כניסה":
            r=sim(daily,i0); trades.append((cut,tk,r)); 
            # מצא תאריך-יציאה משוער (חלון) לחסימת כפילות
            open_until[tk]=(datetime.date.fromisoformat(cut)+datetime.timedelta(days=56)).isoformat()
print(f"\n=== בקטסט מופחת-הטיה: {len(DATA)} מניות, עלות {COST}%/עסקה ===")
print(f"עסקאות: {len(trades)}")
if trades:
    rets=[t[2] for t in trades]; R=[x/8 for x in rets]; wins=[x for x in rets if x>0]
    print(f"מנצחות: {len(wins)}/{len(trades)} ({100*len(wins)//len(trades)}%)")
    print(f"תוחלת: {sum(R)/len(R):+.3f}R/עסקה | סה\"כ {sum(R):+.1f}R (~% חשבון ב-1%/עסקה)")
    from collections import defaultdict
    by=defaultdict(list)
    for cut,tk,r in trades: by[cut[:4]].append(r/8)
    print("לפי שנה:")
    for y in sorted(by): print(f"  {y}: {len(by[y])} עס' · {sum(by[y]):+.1f}R · תוחלת {sum(by[y])/len(by[y]):+.3f}R")
    json.dump([{"date":t[0],"ticker":t[1],"ret":round(t[2],2)} for t in trades],
              open("/home/user/mrtesy-app/docs/smrttrade-spike/goldenset/ubt_trades.json","w"),ensure_ascii=False,indent=1)
