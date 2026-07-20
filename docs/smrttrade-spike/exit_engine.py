"""מנוע-יציאה — כללי-הקורס (יא + ח), מכונת-מצבים יומית על פוזיציה פתוחה.
מחזיר תשואה כוללת ביחידות-סיכון (R) + רשימת-אירועים. ראה exit-engine-spec.md.

פרמטרי-שיקול-דעת (🔴, ניתנים-לכיול): STOP_AIR_PCT/ATR, SCALE_FRAC[_WEAK],
TRAIL_AIR_PCT. יחס-היעד 1:2 (🟢, י-1). כללים 🟢: סטופ/מבני/מומנטום/גאפ/טריילינג.
"""
import indicators as I

# פרמטרי-שיקול-דעת (לכיול על replay — "הניסיון" של המכונה)
STOP_AIR_PCT = 0.025      # אוויר-סטופ מתחת לתמיכה (ח-7 יומי)
STOP_AIR_ATR = 0.5        # ...או 0.5 ATR (ח-6: לא ATR-שלם)
RR_TARGET    = 2.0        # יעד ראשון = 1:2 (י-1)
SCALE_FRAC       = 0.50   # מימוש ביעד (יא-5)
SCALE_FRAC_WEAK  = 0.75   # אם המחזור לא-אישר (יא-5)
TRAIL_AIR_PCT = 0.02      # אוויר סטופ-עוקב מתחת לשפל (ח-7 יומי 2-3%)
# יא-8 (יציאת-מומנטום) מקורה בשיעור-הדוח-החודשי (report-cycles), שיטה ידנית-סלקטיבית —
# כבויה כברירת-מחדל בליבה. ראה scope-separation-changelog.md.
MOMENTUM_ENABLED = False


def simulate_exit(daily, i0, support_low, atr, vol_weak=False, cost_pct=0.30):
    """daily: [(dt,o,h,l,c,v)]; i0: אינדקס-כניסה (כניסה בסגירה). מחזיר (R, events)."""
    entry = daily[i0][4]
    if support_low and support_low < entry:
        init_stop = support_low - max(STOP_AIR_PCT * entry, STOP_AIR_ATR * atr)
    else:
        init_stop = entry * (1 - STOP_AIR_PCT) - STOP_AIR_ATR * atr
    risk = entry - init_stop
    if risk <= 0:
        return None, []
    target1 = entry + RR_TARGET * risk
    stop = init_stop
    remaining = 1.0
    realized_R = 0.0
    scaled = False
    events = []

    def close_frac(frac, price, why):
        nonlocal remaining, realized_R
        realized_R += frac * (price - entry) / risk
        remaining -= frac
        events.append((daily[j][0], why, round(frac, 2), round(price, 2)))

    dh = [r[2] for r in daily]; dl = [r[3] for r in daily]
    for j in range(i0 + 1, len(daily)):
        o, h, l, c = daily[j][1], daily[j][2], daily[j][3], daily[j][4]
        # 1. גאפ (יא-16): פתיחה מתחת לסטופ → מילוי ב-open
        if o <= stop:
            close_frac(remaining, o, "gap"); break
        # 2. סטופ קשיח / אינוולידציה (יא-10)
        if l <= stop:
            close_frac(remaining, stop, "stop"); break
        # 3. מימוש ביעד-1 / 2R (יא-3/5/6): 50% (75% אם מחזור חלש) + סטופ ל-BE
        if not scaled and h >= target1:
            frac = SCALE_FRAC_WEAK if vol_weak else SCALE_FRAC
            close_frac(frac, target1, "target1")
            stop = max(stop, entry)          # break-even על השארית (יא-3)
            scaled = True
            if remaining <= 0.001: break
            continue
        # 4. יציאה מבנית (יא-7): סגירה מתחת לשפל-הציר האחרון → סוגר הכל
        _, lows = I.swings(dh[:j + 1], dl[:j + 1], k=5)
        last_low = lows[-1][1] if lows else None
        if last_low and c < last_low and stop < last_low:
            close_frac(remaining, c, "structural"); break
        # 5. מומנטום על הרץ (יא-8) — report-cycles, כבוי כברירת-מחדל בליבה
        if MOMENTUM_ENABLED and scaled and c < daily[j - 1][3]:
            close_frac(remaining, c, "momentum"); break
        # 6. סטופ עוקב (יא-1/2/13): מתחת לשפל-ציר מאושר, רק כלפי מעלה
        if last_low and c > last_low:
            cand = last_low * (1 - TRAIL_AIR_PCT)
            stop = max(stop, cand)
    else:
        # סוף-נתונים: מימוש שארית בסגירה אחרונה (לא סטופ-זמן שרירותי — פשוט קצה-הדאטה)
        close_frac(remaining, daily[-1][4], "data_end")
    # עלות/החלקה: ~cost_pct% מהעסקה, בהמרה ל-R
    realized_R -= (cost_pct / 100.0) * entry / risk
    return realized_R, events
