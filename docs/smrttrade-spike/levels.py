"""גלאי-רמות אלגוריתמי — תיקון ממצא #1.

רמה = אזור שאליו מתאשכלים כמה פיבוטים (ג-6: יותר נגיעות=חזק יותר),
משוקלל לפי טיים-פריים (ג-5: שבועי>יומי) ומספרים-עגולים (ג-18, שיעור 38).
מחליף את nearest_resistance/nearest_support הנאיביים.

חוזק-רמה (strength) הוא **רצף** (לא סף בינארי) — תואם ג-6 ("יותר=חזק, ללא סף
מינימלי"). בחירת יעד/תמיכה משתמשת ב-MIN_STRENGTH כרצפה מתועדת אחת בלבד.
"""
import numpy as np
import indicators as I

# ── פרמטרים הנדסיים (לא מהקורס — לכיול על הגולדן-סט, לא ערכי-קורס) ──
CLUSTER_TOL_ATR = 0.6      # סבולת-אשכול = 0.6 × ATR
ROUND_TOL_PCT = 0.002      # "קרבה למספר עגול" = 0.2%
MIN_STRENGTH = 2           # רצפת-משמעותיות (weight + בונוס-עגול). ברירת-מחדל לכיול.


def _round_hit(price):
    """קרבה למספר עגול — ג-18 (שיעור 38). **רק ערכי-הקורס: 50/100/200.**"""
    for step in (200, 100, 50):
        nearest = round(price / step) * step
        if nearest > 0 and abs(price - nearest) <= max(0.01, price * ROUND_TOL_PCT):
            return True
    return False


def cluster(pivots, atr, price):
    """pivots = [(value, weight)]. ממזג פיבוטים במרחק ≤ tol לאזור אחד."""
    if not pivots:
        return []
    tol = max(CLUSTER_TOL_ATR * atr, 0.008 * price)
    pivots = sorted(pivots)
    zones = [[pivots[0]]]
    for v, w in pivots[1:]:
        if v - zones[-1][-1][0] <= tol:
            zones[-1].append((v, w))
        else:
            zones.append([(v, w)])
    out = []
    for z in zones:
        vals = [v for v, _ in z]
        weight = sum(w for _, w in z)            # שבועי סופר כפול (ג-5)
        center = float(np.average(vals, weights=[w for _, w in z]))
        is_round = _round_hit(center)
        # חוזק רציף: נגיעות (ג-6) + טיים-פריים (ג-5, כבר ב-weight) + מספר-עגול (ג-18)
        strength = weight + (1 if is_round else 0)
        out.append(dict(center=round(center, 2), weight=weight, touches=len(z),
                        round=is_round, strength=strength))
    return out


def levels(daily, weekly):
    dh = [r[2] for r in daily]; dl = [r[3] for r in daily]
    wh = [r[2] for r in weekly]; wl = [r[3] for r in weekly]
    price = daily[-1][4]
    atr = I.atr(dh, dl, [r[4] for r in daily], 14)
    d_hi, d_lo = I.swings(dh, dl, k=5)
    w_hi, w_lo = I.swings(wh, wl, k=3)
    res_piv = [(v, 1) for _, v in d_hi] + [(v, 2) for _, v in w_hi]   # שבועי משקל 2
    sup_piv = [(v, 1) for _, v in d_lo] + [(v, 2) for _, v in w_lo]
    res = [z for z in cluster(res_piv, atr, price) if z['center'] > price]
    sup = [z for z in cluster(sup_piv, atr, price) if z['center'] < price]
    res.sort(key=lambda z: z['center'])
    sup.sort(key=lambda z: -z['center'])
    return dict(price=price, atr=atr, resistance=res, support=sup)


def significant_target(lv, min_strength=MIN_STRENGTH):
    """יעד = אזור-התנגדות בעל חוזק ≥ סף, הקרוב מעל, מעבר לרעש שליד המחיר (>0.75 ATR)."""
    price, atr = lv['price'], lv['atr']
    for z in lv['resistance']:
        if z['center'] > price + 0.75 * atr and z['strength'] >= min_strength:
            return z
    sig = [z for z in lv['resistance'] if z['strength'] >= min_strength]
    return sig[-1] if sig else (lv['resistance'][-1] if lv['resistance'] else None)


def significant_stop_support(lv, min_strength=MIN_STRENGTH):
    for z in lv['support']:
        if z['strength'] >= min_strength:
            return z
    return lv['support'][0] if lv['support'] else None
