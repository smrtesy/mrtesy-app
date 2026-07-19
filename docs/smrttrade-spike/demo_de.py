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

# ── רינדור גרף יומי אחרון ~130 ימים עם הרמות מסומנות ──
d = daily[-130:]
xs = list(range(len(d)))
op = [r[1] for r in d]; hi = [r[2] for r in d]; lo = [r[3] for r in d]; cl = [r[4] for r in d]
fig, ax = plt.subplots(figsize=(13, 7))
for i in range(len(d)):
    color = "#26a69a" if cl[i] >= op[i] else "#ef5350"
    ax.plot([xs[i], xs[i]], [lo[i], hi[i]], color=color, linewidth=0.8, zorder=1)
    ax.plot([xs[i], xs[i]], [op[i], cl[i]], color=color, linewidth=3.2, zorder=1, solid_capstyle="butt")
# רמות התנגדות (אדום) ותמיכה (ירוק), עובי לפי משקל
for z in lv["resistance"]:
    ax.axhline(z["center"], color="#c62828", lw=0.8 + 0.5 * z["weight"], alpha=0.75, zorder=0)
    ax.text(len(d) + 0.5, z["center"], f"{z['center']:.0f} (w{z['weight']})", color="#c62828", va="center", fontsize=8)
for z in lv["support"][:4]:
    ax.axhline(z["center"], color="#2e7d32", lw=0.8 + 0.5 * z["weight"], alpha=0.6, zorder=0)
    ax.text(len(d) + 0.5, z["center"], f"{z['center']:.0f} (w{z['weight']})", color="#2e7d32", va="center", fontsize=8)
ax.axhline(lv["price"], color="#1565c0", lw=1.4, ls="--", zorder=2)
ax.text(0, lv["price"], f"price {lv['price']:.1f}", color="#1565c0", va="bottom", fontsize=9)
# ── תאריכים אמיתיים על ציר-ה-X (חודש+יום) להשוואה מול גרף אמיתי ──
dates = [r[0] for r in d]                      # 'YYYY-MM-DD'
import datetime as _dt
ticks = list(range(0, len(d), 10)) + [len(d) - 1]
labels = [_dt.date.fromisoformat(dates[i]).strftime("%d %b") for i in ticks]  # e.g. 14 Jul
ax.set_xticks(ticks); ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
ax.set_title(f"{TK} — daily  {dates[0]} → {dates[-1]}  (point-in-time, cutoff {H.CUTOFF})")
ax.set_xlabel("date (day mon)"); ax.set_ylabel("price $"); ax.margins(x=0.02)
ax.grid(axis="x", color="#eeeeee", lw=0.6, zorder=0)
plt.tight_layout()
out = "de_levels.png"
plt.savefig(out, dpi=110)
print(f"\nסומן גרף: {out}")
