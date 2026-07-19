"""אינדיקטורים טכניים טהורים (numpy) — smrtTrade T1.4 spike.
כולם מחושבים מ-OHLCV גולמי בלבד, נקודת-בזמן (בלי הצצה קדימה)."""
import numpy as np


def sma(x, n):
    x = np.asarray(x, float)
    if len(x) < n:
        return np.nan
    return float(np.mean(x[-n:]))


def sma_series(x, n):
    x = np.asarray(x, float)
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        out[i] = np.mean(x[i - n + 1:i + 1])
    return out


def ema_series(x, n):
    x = np.asarray(x, float)
    k = 2.0 / (n + 1)
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = np.mean(x[:n])
    for i in range(n, len(x)):
        out[i] = x[i] * k + out[i - 1] * (1 - k)
    return out


def rsi(close, n=14):
    close = np.asarray(close, float)
    if len(close) < n + 1:
        return np.nan
    d = np.diff(close)
    gain = np.where(d > 0, d, 0.0)
    loss = np.where(d < 0, -d, 0.0)
    ag = np.mean(gain[:n]); al = np.mean(loss[:n])
    for i in range(n, len(d)):
        ag = (ag * (n - 1) + gain[i]) / n
        al = (al * (n - 1) + loss[i]) / n
    if al == 0:
        return 100.0
    rs = ag / al
    return float(100 - 100 / (1 + rs))


def macd(close, fast=12, slow=26, sig=9):
    ef = ema_series(close, fast)
    es = ema_series(close, slow)
    line = ef - es
    valid = line[~np.isnan(line)]
    signal = ema_series(valid, sig)
    macd_v = float(line[-1]) if not np.isnan(line[-1]) else np.nan
    sig_v = float(signal[-1]) if len(signal) and not np.isnan(signal[-1]) else np.nan
    return macd_v, sig_v


def atr(high, low, close, n=14):
    high = np.asarray(high, float); low = np.asarray(low, float); close = np.asarray(close, float)
    if len(close) < n + 1:
        return np.nan
    tr = np.maximum(high[1:] - low[1:],
                    np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
    a = np.mean(tr[:n])
    for i in range(n, len(tr)):
        a = (a * (n - 1) + tr[i]) / n
    return float(a)


def swings(high, low, k=5):
    """נקודות-ציר (fractals): שיא/שפל מקומי בחלון ±k. מחזיר אינדקסים+ערכים."""
    high = np.asarray(high, float); low = np.asarray(low, float)
    highs, lows = [], []
    for i in range(k, len(high) - k):
        if high[i] == max(high[i - k:i + k + 1]):
            highs.append((i, float(high[i])))
        if low[i] == min(low[i - k:i + k + 1]):
            lows.append((i, float(low[i])))
    return highs, lows


def _slope(pts, m=4):
    """שיפוע רגרסיה על עד m הסווינגים האחרונים (חסין יותר מ-2 נקודות בלבד)."""
    pts = pts[-m:]
    if len(pts) < 2:
        return 0.0
    xs = np.array([i for i, _ in pts], float)
    ys = np.array([v for _, v in pts], float)
    return float(np.polyfit(xs, ys, 1)[0])


def trend_structure(high, low, k=5):
    """מגמה לפי מבנה דאו: שיפוע שיאים+שפלים על עד 4 סווינגים.
    עולה=שניהם עולים · יורדת=שניהם יורדים · אחרת=דשדוש."""
    highs, lows = swings(high, low, k)
    if len(highs) < 2 or len(lows) < 2:
        return "range", highs, lows
    sh, sl = _slope(highs), _slope(lows)
    if sh > 0 and sl > 0:
        return "up", highs, lows
    if sh < 0 and sl < 0:
        return "down", highs, lows
    return "range", highs, lows


def nearest_resistance(price, highs, closes_max):
    """התנגדות קרובה מעל המחיר (שיא-ציר קרוב, אחרת שיא-כל-הזמנים)."""
    above = sorted([v for _, v in highs if v > price])
    if above:
        return above[0]
    return float(closes_max)


def nearest_support(price, lows):
    below = sorted([v for _, v in lows if v < price], reverse=True)
    if below:
        return below[0]
    return None
