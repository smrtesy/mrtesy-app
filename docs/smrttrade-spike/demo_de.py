"""הדגמת ממצא #1: גלאי-הרמות לבד (מנתונים) מול הקריאה הידנית (604/674),
+ רינדור גרף לאימות-ויזואלי צולב. הכל נקודת-בזמן (cutoff 14/07), $0.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import harness as H
import levels as L

TK = "DE"
daily = H.fetch(TK)
weekly = H.to_weekly(daily)
lv = L.levels(daily, weekly)
tgt = L.significant_target(lv)
stp = L.significant_stop_support(lv)

print(f"=== {TK}  price={lv['price']:.2f}  ATR={lv['atr']:.1f} ===")
print("אזורי-התנגדות (center · weight · touches · score):")
for z in lv["resistance"]:
    print(f"   {z['center']:.1f}  w={z['weight']} t={z['touches']} score={z['score']:.1f}")
print("אזורי-תמיכה:")
for z in lv["support"][:5]:
    print(f"   {z['center']:.1f}  w={z['weight']} t={z['touches']} score={z['score']:.1f}")
print(f"\n→ יעד-אלגוריתם (משמעותי, >0.75ATR מעל): {tgt['center']:.1f}  (ידני: 604→674)")
print(f"→ סטופ-תמיכה: {stp['center']:.1f}" if stp else "→ אין תמיכה")

# ── רינדור: גרף מחיר + פאנל-נפח (~130 ימים) עם הרמות מסומנות ──
d = daily[-130:]
xs = list(range(len(d)))
op = [r[1] for r in d]; hi = [r[2] for r in d]; lo = [r[3] for r in d]; cl = [r[4] for r in d]
vol = [r[5] for r in d]
# ממוצע-נפח נע 20 (הבסיס להשוואות "מחזור גבוה/דועך" של הקורס)
import numpy as _np
vsma = [float(_np.mean(vol[max(0, i - 19):i + 1])) for i in range(len(vol))]
fig, (ax, axv) = plt.subplots(2, 1, figsize=(13, 8.5), sharex=True,
                              gridspec_kw={"height_ratios": [3.2, 1], "hspace": 0.05})
for i in range(len(d)):
    color = "#26a69a" if cl[i] >= op[i] else "#ef5350"
    ax.plot([xs[i], xs[i]], [lo[i], hi[i]], color=color, linewidth=0.8, zorder=1)
    ax.plot([xs[i], xs[i]], [op[i], cl[i]], color=color, linewidth=3.2, zorder=1, solid_capstyle="butt")
    # פאנל-נפח: עמודה לכל יום, צבע לפי נר עולה/יורד; הדגשת נפח חריג (>1.5× ממוצע)
    vcolor = "#26a69a" if cl[i] >= op[i] else "#ef5350"
    axv.bar(xs[i], vol[i] / 1e6, width=0.8,
            color=vcolor, alpha=0.9 if vol[i] > 1.5 * vsma[i] else 0.45, zorder=1)
axv.plot(xs, [v / 1e6 for v in vsma], color="#5c6bc0", lw=1.3, zorder=2, label="20-day avg vol")
axv.set_ylabel("Volume (M)", fontsize=9)
axv.legend(loc="upper left", fontsize=8)
axv.grid(axis="y", color="#f0f0f0", lw=0.5)
# רמות התנגדות (אדום) ותמיכה (ירוק), עובי לפי משקל
for z in lv["resistance"]:
    ax.axhline(z["center"], color="#c62828", lw=0.8 + 0.5 * z["weight"], alpha=0.75, zorder=0)
    ax.text(len(d) + 0.5, z["center"], f"{z['center']:.0f} (w{z['weight']})", color="#c62828", va="center", fontsize=8)
for z in lv["support"][:4]:
    ax.axhline(z["center"], color="#2e7d32", lw=0.8 + 0.5 * z["weight"], alpha=0.6, zorder=0)
    ax.text(len(d) + 0.5, z["center"], f"{z['center']:.0f} (w{z['weight']})", color="#2e7d32", va="center", fontsize=8)
ax.axhline(lv["price"], color="#1565c0", lw=1.4, ls="--", zorder=2)
ax.text(0, lv["price"], f"price {lv['price']:.1f}", color="#1565c0", va="bottom", fontsize=9)
# ── תאריכים אמיתיים על ציר-ה-X של הפאנל התחתון (חודש+יום) ──
dates = [r[0] for r in d]                      # 'YYYY-MM-DD'
import datetime as _dt
ticks = list(range(0, len(d), 10)) + [len(d) - 1]
labels = [_dt.date.fromisoformat(dates[i]).strftime("%d %b") for i in ticks]  # e.g. 14 Jul
axv.set_xticks(ticks); axv.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
axv.set_xlabel("date (day mon)")
ax.set_title(f"{TK} — daily  {dates[0]} → {dates[-1]}  (point-in-time, cutoff {H.CUTOFF})")
ax.set_ylabel("price $"); ax.margins(x=0.02)
ax.grid(axis="x", color="#eeeeee", lw=0.6, zorder=0)
plt.tight_layout()
out = "de_levels.png"
plt.savefig(out, dpi=110)
print(f"\nסומן גרף: {out}")
