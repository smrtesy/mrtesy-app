"""גלאי-רמות אלגוריתמי — תיקון ממצא #1.

רמה = אזור שאליו מתאשכלים כמה פיבוטים (ג-6: יותר נגיעות=חזק יותר),
משוקלל לפי טיים-פריים (ג-5: שבועי>יומי) ומספרים-עגולים (ג-18).
מחליף את nearest_resistance/nearest_support הנאיביים.
"""
import numpy as np
import indicators as I


def _round_bonus(price):
    """קרבה למספר עגול (50/100/...) — ג-18."""
    for step in (100, 50, 25, 10):
        if abs(price - round(price / step) * step) <= max(0.5, price * 0.002):
            return 0.5
    return 0.0


def cluster(pivots, atr, price):
    """pivots = [(value, weight)]. ממזג פיבוטים במרחק ≤ tol לאזור אחד."""
    if not pivots:
        return []
    tol = max(0.6 * atr, 0.008 * price)
    pivots = sorted(pivots)
    zones = []
    cur = [pivots[0]]
    for v, w in pivots[1:]:
        if v - cur[-1][0] <= tol:
            cur.append((v, w))
        else:
            zones.append(cur); cur = [(v, w)]
    zones.append(cur)
    out = []
    for z in zones:
        vals = [v for v, _ in z]
        weight = sum(w for _, w in z)            # שבועי סופר כפול
        center = float(np.average(vals, weights=[w for _, w in z]))
        out.append(dict(center=round(center, 2), weight=weight,
                        touches=len(z), score=weight + _round_bonus(center)))
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


def significant_target(lv, min_weight=2):
    """יעד = אזור-ההתנגדות המשמעותי הקרוב מעל, מעבר לרעש שליד המחיר (>0.75 ATR)."""
    price, atr = lv['price'], lv['atr']
    for z in lv['resistance']:
        if z['center'] > price + 0.75 * atr and z['weight'] >= min_weight:
            return z
    # נפילה חזרה: הפיבוט-המשמעותי הכי גבוה אם אין כזה קרוב
    sig = [z for z in lv['resistance'] if z['weight'] >= min_weight]
    return sig[-1] if sig else (lv['resistance'][-1] if lv['resistance'] else None)


def significant_stop_support(lv, min_weight=2):
    for z in lv['support']:
        if z['weight'] >= min_weight:
            return z
    return lv['support'][0] if lv['support'] else None
