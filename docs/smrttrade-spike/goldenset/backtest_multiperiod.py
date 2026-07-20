import json, datetime, sys, urllib.request
sys.path.insert(0,"/home/user/mrtesy-app/docs/smrttrade-spike")
import harness as H, indicators as I, levels as L
import numpy as np
REG=json.load(open("/home/user/mrtesy-app/docs/stock-course-rules.registry.json"))
UNIV="AAPL MSFT NVDA GOOGL AMZN META TSLA AMD AVGO NFLX ORCL CRM ADBE QCOM INTC CAT DE JPM XOM WMT KO PEP DIS BA NKE PLTR SOFI RBLX RIVN COIN MARA UBER SHOP".split()
STOP=0.08; TARGET=0.16; WIN=56

def fetch_full(tk):
    url=f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?range=5y&interval=1d"
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
    d=json.load(urllib.request.urlopen(req,timeout=30))["chart"]["result"][0]
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

print("fetching universe...",flush=True)
DATA={}
for tk in UNIV+["SPY"]:
    try: DATA[tk]=fetch_full(tk)
    except Exception as e: print("skip",tk,e)
spy=DATA.pop("SPY"); spy_c=[r[4] for r in spy]; spy_dates=[r[0] for r in spy]
def spy_above(cut):
    idx=[i for i,d in enumerate(spy_dates) if d<=cut]
    if len(idx)<200: return None
    seg=spy_c[:idx[-1]+1]; return seg[-1] > float(np.mean(seg[-200:]))

# תאריכי-סריקה: כל 2 שבועות מ-2023-06 עד 2026-02
start=datetime.date(2023,6,2); end=datetime.date(2026,2,20); cur=start; dates=[]
while cur<=end: dates.append(cur.isoformat()); cur+=datetime.timedelta(days=14)

def simulate(daily, i0):
    entry=daily[i0][4]; stop=entry*(1-STOP); tgt=entry*(1+TARGET)
    end_i=min(i0+40, len(daily)-1)
    for j in range(i0+1, end_i+1):
        if daily[j][3]<=stop: return -STOP*100, daily[j][0]
        if daily[j][2]>=tgt: return TARGET*100, daily[j][0]
    return (daily[end_i][4]/entry-1)*100, daily[end_i][0]

trades=[]; open_until={}
for cut in dates:
    sab=spy_above(cut)
    for tk,daily in DATA.items():
        di=[i for i,r in enumerate(daily) if r[0]<=cut]
        if len(di)<220: continue
        i0=di[-1]
        if open_until.get(tk,"")>=cut: continue     # לא לפתוח כפילות בזמן פוזיציה פתוחה
        dsl=daily[:i0+1]; wsl=weekly(dsl)
        try:
            ctx=H.build_context(tk,dsl,wsl,{"above_200":sab})
            led=H.evaluate(REG,ctx); dec,reason=H.decide(ctx,led)
        except Exception: continue
        dec=dec.replace("→כניסה","").strip()
        if dec=="כניסה":
            r,exitd=simulate(daily,i0)
            trades.append((cut,tk,r,exitd)); open_until[tk]=exitd
print(f"\nסה\"כ עסקאות (איתות 'כניסה' של המנוע): {len(trades)}")
if trades:
    rets=[t[2] for t in trades]; wins=[x for x in rets if x>0]
    import statistics
    R=[x/8 for x in rets]  # יחידות-סיכון
    print(f"מנצחות: {len(wins)}/{len(trades)} ({100*len(wins)//len(trades)}%)")
    print(f"תשואה ממוצעת/עסקה: {sum(rets)/len(rets):+.2f}%  |  תוחלת: {sum(R)/len(R):+.3f}R לעסקה")
    print(f"סה\"כ יחידות-סיכון (1%/עסקה → ~% חשבון): {sum(R):+.1f}R")
    # פילוח לפי שנה
    from collections import defaultdict
    by=defaultdict(list)
    for cut,tk,r,ed in trades: by[cut[:4]].append(r/8)
    print("\nלפי שנה (סכום R):")
    for y in sorted(by): print(f"  {y}: {len(by[y])} עסקאות · {sum(by[y]):+.1f}R · תוחלת {sum(by[y])/len(by[y]):+.3f}R")
    json.dump([{"date":t[0],"ticker":t[1],"ret":t[2],"exit":t[3]} for t in trades],
              open("/home/user/mrtesy-app/docs/smrttrade-spike/goldenset/mbt_trades.json","w"),ensure_ascii=False,indent=1)
