import os, json, sys
sys.path.insert(0,"/home/user/mrtesy-app/docs/smrttrade-spike")
import harness as H, indicators as I
SP="/tmp/claude-0/-home-user-mrtesy-app/6ef186ba-2c6c-5b54-91a7-726038b28b8c/scratchpad"
VIDS=[("2026-01-15","2026-01-14","OPLj8QBUPtU"),("2026-01-20","2026-01-19","FhJCmHQD7cY"),
      ("2026-01-28","2026-01-27","ZPe7kHfo-04"),("2026-02-10","2026-02-09","HN2bbzxoPCg"),
      ("2026-02-17","2026-02-16","XETdeY0BwkA")]
reg=json.load(open("/home/user/mrtesy-app/docs/stock-course-rules.registry.json"))
def primary(lbl):
    if lbl=="כניסה": return "כניסה"
    if lbl.startswith("הימנעות"): return "הימנעות"
    return "מעקב"
def norm(x): return x.replace("→כניסה","").replace("נפסל","הימנעות").strip()
locked={}; allrows=[]
for vdate,cutoff,vid in VIDS:
    H.CUTOFF=cutoff                                   # נקודת-בזמן לסרטון זה
    spy=H.fetch("SPY"); spy_ctx={"above_200": spy[-1][4] > I.sma([r[4] for r in spy],200)}
    ziv=json.load(open(f"{SP}/ziv_verdicts_{vdate}.json"))
    hi=[z for z in ziv if z.get("confidence")=="high" and z.get("ticker_guess")]
    locked[vdate]={}
    for z in hi:
        tk=z["ticker_guess"]
        try:
            ctx,led,dec,reason,cov,gaps=H.run(tk,spy_ctx,reg)
        except Exception as e:
            allrows.append((vdate,tk,"שגיאה",z["label"],"?",False,True)); continue
        locked[vdate][tk]=dec
        pr=primary(z["label"]); ok=norm(dec)==norm(pr)
        discriminating = pr!="מעקב"
        allrows.append((vdate,tk,dec,z["label"],pr,ok,discriminating))
json.dump(locked,open(f"{SP}/locked_decisions_janfeb2026.json","w"),ensure_ascii=False,indent=2)
# דוחות
for vdate,_,vid in VIDS:
    rows=[r for r in allrows if r[0]==vdate and r[2]!="שגיאה"]
    ag=sum(1 for r in rows if r[5])
    print(f"\n## {vdate} ({vid})  —  תיאום {ag}/{len(rows)}")
    for _,tk,dec,lbl,pr,ok,disc in rows:
        mark="✅" if ok else "⚠️"
        d="  ★מבחין" if disc else ""
        print(f"   {mark} {tk:6} רתמה={dec:8} זיו={lbl}{d}")
# אגרגט + מבחין
good=[r for r in allrows if r[2]!="שגיאה"]
ag=sum(1 for r in good if r[5]); disc=[r for r in good if r[6]]; disc_ag=sum(1 for r in disc if r[5])
err=[r for r in allrows if r[2]=="שגיאה"]
print(f"\n===== אגרגט =====")
print(f"תיאום תווית-על כולל: {ag}/{len(good)}  ({100*ag//len(good)}%)")
print(f"מקרים מבחינים (זיו כניסה/הימנעות): {len(disc)} → תואמו: {disc_ag}")
for r in disc: print(f"   מבחין: {r[0]} {r[1]} רתמה={r[2]} זיו={r[3]} {'✅' if r[5] else '⚠️'}")
if err: print("שגיאות-הבאה:", [(r[0],r[1]) for r in err])
