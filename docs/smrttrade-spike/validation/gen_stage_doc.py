# -*- coding: utf-8 -*-
import json
from collections import Counter
reg = json.load(open('/home/user/mrtesy-app/docs/stock-course-rules.registry.json'))
core = [r for r in reg['rules'] if r.get('scope') == 'core']
byid = {r['id']: r for r in core}

STAGE = {
 "1. החלטת כניסה — מה ולאיזה כיוון": ["א","ב","ג","ו"],
 "2. זמן כניסה — מתי למשוך בהדק":     ["ד","ה","ז"],
 "3. סטופ-לוס התחלתי":                ["ח"],
 "4. העלאת סטופ (טריילינג)":          [],
 "5. אסטרטגיית יציאה מלאה":           ["י"],
 "6. חוצה-שלבים — גודל-פוזיציה, סיכון, משמעת": ["ט","יג"],
}
INJECT = {
 "1. החלטת כניסה — מה ולאיזה כיוון": ["יב-1"],
 "4. העלאת סטופ (טריילינג)": ["יא-1","יא-2","יא-13"],
 "5. אסטרטגיית יציאה מלאה": ["יא-3","יא-4","יא-5","יא-6","יא-7","יא-9","יא-10","יא-11","יא-12","יא-14","יא-15","יא-16"],
}
ENFORCED = {"א-4","א-5","ב-3","ג-10","י-3","ה-11","ה-3","ז-7",
            "ח-6","ח-7","יא-1","יא-3","יא-5","יא-7","יא-10","יא-16","י-1"}
COMPUTED_ONLY = {"א-9","ב-10","ב-17","ה-5","ה-12","ו-2","ו-4","ו-12","יב-5","יא-2","יא-13"}
PARTIAL_NOTE = {
 "ה-11": "מומש ~שליש (רק מחזור-פולבק דועך); חסר גלי-עלייה-במחזור + פריצה-במחזור",
 "ב-17": "מומש כפרוקסי-ממוצעים (price>SMA50>SMA200), לא מבנה-דאו + מרווח-זמן ≥4ח'",
 "ז-7":  "מחווט לאותו דגל נר-אישור כמו ה-3",
}
OFF = {"יא-8"}
TAG = {"computable":"מחושב","vision":"ויזואלי","manual":"שיפוט"}
NOVIS = {"computable":"✅ כן (מ-OHLCV)","vision":"🟡 פרוקסי בלבד","manual":"⛔ לא (שיפוט אנושי)"}
def status(rid):
    if rid in OFF: return "🔌 ממומש-כבוי (report-cycles)"
    if rid in ENFORCED: return "✅ נאכף"
    if rid in COMPUTED_ONLY: return "🟡 מחושב / לא-נאכף (או חלקי)"
    return "⬜ לא-ממומש"

def block(n, rid):
    r = byid[rid]; q = (r.get('quote') or '').strip().replace("\n"," ")
    st = status(rid); note = PARTIAL_NOTE.get(rid)
    if note: st += f" · {note}"
    src = ",".join(str(s) for s in (r.get('sources') or []))
    lines = [f"**{n}. `{rid}` — {r['statement']}**  ",
             f"> {q}  ",
             f"תיוג: {TAG[r['evaluable']]} · ללא-ויזואל: {NOVIS[r['evaluable']]} · סטטוס: {st}"
             + (f" · מקורות: שיעורים {src}" if src else "")]
    return "\n".join(lines)

out = []
out.append("# כללי-הקורס לפי שלבי-העסקה — טבלת-אב\n")
out.append("רשימה ממוספרת של כל 176 כללי-הליבה, מחולקת ל-5 שלבי-העסקה (+חוצה-שלבים), "
           "עם ציטוט מהקורס לכל כלל, האם ניתן ליישם ללא-ויזואל, ומה כבר ממומש. "
           "**יחוס:** כל כלל מזוהה במזהה-הקורס שלו (למשל `ה-3`).\n")
out.append("מקור: `docs/stock-course-rules.registry.json` · סטטוס מאומת מול "
           "`docs/smrttrade-spike/harness.py` + `exit_engine.py`.\n")
out.append("**מקרא סטטוס:** ✅ נאכף (חוסם/מפעיל החלטה בקוד) · 🟡 מחושב אך לא-נאכף / חלקי · "
           "🔌 ממומש אך כבוי · ⬜ לא-ממומש.\n")

# תקציר מנהלים
out.append("## תקציר — מה קיים\n")
out.append("| שלב | כללים | מחושב | ויזואלי | שיפוט | נאכף בקוד |")
out.append("|---|---|---|---|---|---|")
tot=Counter()
stage_ids={}
for stage,cats in STAGE.items():
    ids=[r['id'] for r in core if r['category'] in cats]+INJECT.get(stage,[])
    ids=[i for i in ids if i in byid]; stage_ids[stage]=ids
    ev=Counter(byid[i]['evaluable'] for i in ids)
    enf=sum(1 for i in ids if status(i).startswith('✅'))
    out.append(f"| {stage} | {len(ids)} | {ev.get('computable',0)} | {ev.get('vision',0)} | {ev.get('manual',0)} | {enf} |")
    tot['n']+=len(ids); tot['c']+=ev.get('computable',0); tot['v']+=ev.get('vision',0); tot['m']+=ev.get('manual',0); tot['e']+=enf
out.append(f"| **סה\"כ** | **{tot['n']}** | **{tot['c']}** | **{tot['v']}** | **{tot['m']}** | **{tot['e']}** |")
out.append("\n**התשובה הישירה:** יש לנו את *כל* הכללים עם ציטוטים והגדרה. אבל הגדרה "
           "ברורה ליישום **ללא-ויזואל** קיימת רק ל-93 המחושבים; 29 הוויזואליים ניתנים "
           "לכל-היותר כפרוקסי, ו-54 השיפוט אינם ניתנים למכניזציה. מתוך המחושבים — רק "
           f"{tot['e']} נאכפים כרגע בקוד.\n")

for stage in STAGE:
    ids=stage_ids[stage]
    out.append(f"\n## {stage}\n")
    ev=Counter(byid[i]['evaluable'] for i in ids)
    enf=sum(1 for i in ids if status(i).startswith('✅'))
    out.append(f"*{len(ids)} כללים · מחושב {ev.get('computable',0)} / ויזואלי {ev.get('vision',0)} / שיפוט {ev.get('manual',0)} · נאכף {enf}*\n")
    for n,i in enumerate(ids,1):
        out.append(block(n,i)+"\n")

open('/home/user/mrtesy-app/docs/smrttrade-spike/validation/COURSE-RULES-BY-STAGE.md','w').write("\n".join(out))
placed=sum(len(v) for v in stage_ids.values())
print("wrote doc ·",placed,"rules placed")
