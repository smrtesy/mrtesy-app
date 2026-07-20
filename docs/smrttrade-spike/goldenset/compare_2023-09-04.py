import os, json
os.environ["SMRTTRADE_CUTOFF"] = "2023-09-01"   # נקודת-בזמן: סוף השבוע שלפני הסקירה
import sys; sys.path.insert(0, "/home/user/mrtesy-app/docs/smrttrade-spike")
import harness as H, indicators as I

SP="/tmp/claude-0/-home-user-mrtesy-app/6ef186ba-2c6c-5b54-91a7-726038b28b8c/scratchpad"
ziv=json.load(open(f"{SP}/ziv_verdicts_2023-09-04.json"))
# מיפוי החלטת-זיו לקטגוריה גסה
def ziv_dec(d):
    return {"entry":"כניסה","watch":"מעקב","bullish":"מעקב","unclear":"מעקב",
            "avoid":"הימנעות","bearish":"הימנעות"}.get(d,"?")
# טיקרים בביטחון גבוה + מניה (לא ETF: מסירים SOXX)
hi=[z for z in ziv if z.get("confidence")=="high" and z.get("ticker_guess") and z["ticker_guess"]!="SOXX"]

reg=json.load(open("/home/user/mrtesy-app/docs/stock-course-rules.registry.json"))
spy=H.fetch("SPY"); spy_ctx={"above_200": spy[-1][4] > I.sma([r[4] for r in spy],200)}
print(f"cutoff={H.CUTOFF} | SPY מעל SMA200: {spy_ctx['above_200']}\n")
def norm(x): return x.replace("→כניסה","").replace("נפסל","הימנעות").strip()
agree=0; tot=0
print(f"{'טיקר':6} {'רתמה':10} {'זיו':10} {'תיאום'}")
for z in hi:
    tk=z["ticker_guess"]
    try:
        ctx,led,dec,reason,cov,gaps=H.run(tk,spy_ctx,reg)
    except Exception as e:
        print(f"{tk:6} שגיאה: {e}"); continue
    zd=ziv_dec(z["decision"]); tot+=1
    ok = norm(dec)==norm(zd)
    agree+=ok
    print(f"{tk:6} {dec:10} {zd:10} {'✅' if ok else '⚠️'}  (זיו: {z['decision']}, מחיר~{ctx['price']:.0f})")
print(f"\nתיאום-החלטה: {agree}/{tot}")
