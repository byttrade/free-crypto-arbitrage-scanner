from __future__ import annotations

import math


def ols(x: list[float], y: list[float]) -> tuple[float, float]:
    n = len(x)
    sx = sy = sxx = sxy = 0.0
    for i in range(n):
        sx += x[i]
        sy += y[i]
        sxx += x[i] * x[i]
        sxy += x[i] * y[i]
    den = n * sxx - sx * sx
    if abs(den) < 1e-12:
        return (sy / n if n else 0.0, 0.0)
    b = (n * sxy - sx * sy) / den
    a = (sy - b * sx) / n
    return a, b


def pearson(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n < 8:
        return 0.0
    ma = sum(a[:n]) / n
    mb = sum(b[:n]) / n
    num = da = db = 0.0
    for i in range(n):
        xa, xb = a[i] - ma, b[i] - mb
        num += xa * xb
        da += xa * xa
        db += xb * xb
    den = math.sqrt(da * db)
    return 0.0 if den < 1e-12 else num / den


def returns(close: list[float]) -> list[float]:
    out = []
    for i in range(1, len(close)):
        if close[i - 1] > 0 and close[i] > 0:
            out.append(math.log(close[i] / close[i - 1]))
    return out


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _solve(mat: list[list[float]], vec: list[float]) -> list[float] | None:
    n = len(vec)
    a = [row[:] + [vec[i]] for i, row in enumerate(mat)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        scale = a[col][col]
        for j in range(col, n + 1):
            a[col][j] /= scale
        for row in range(n):
            if row == col:
                continue
            factor = a[row][col]
            for j in range(col, n + 1):
                a[row][j] -= factor * a[col][j]
    return [a[i][n] for i in range(n)]


def _mackinnon_p(stat: float) -> float:
    # Две серии, константа в коинтеграции. MacKinnon 1994, N=2, regression c.
    if stat > 0.92:
        return 1.0
    if stat < -18.86:
        return 0.0
    coef = (2.92, 1.5012, 0.039796) if stat <= -2.62 else (2.1945, 0.64695, -0.29198, -0.042377)
    z = 0.0
    for c in reversed(coef):
        z = z * stat + c
    return max(0.0, min(1.0, _norm_cdf(z)))


def _adf_t(series: list[float], lags: int, start: int) -> tuple[float, float, int] | None:
    rows, dy = [], []
    for t in range(start, len(series)):
        reg = [series[t - 1]]
        for k in range(1, lags + 1):
            reg.append(series[t - k] - series[t - k - 1])
        rows.append(reg)
        dy.append(series[t] - series[t - 1])
    m = len(dy)
    k = lags + 1
    if m <= k + 2:
        return None
    xtx = [[0.0] * k for _ in range(k)]
    xty = [0.0] * k
    for i in range(m):
        for c in range(k):
            xty[c] += rows[i][c] * dy[i]
            for d in range(c, k):
                xtx[c][d] += rows[i][c] * rows[i][d]
    for c in range(k):
        for d in range(c):
            xtx[c][d] = xtx[d][c]
    beta = _solve(xtx, xty)
    if not beta:
        return None
    sse = 0.0
    for i in range(m):
        err = dy[i] - sum(beta[c] * rows[i][c] for c in range(k))
        sse += err * err
    if sse <= 1e-18:
        return -100.0, 1e-18, m
    inv = _solve(xtx, [1.0] + [0.0] * (k - 1))
    if not inv:
        return None
    se = math.sqrt(max(sse / (m - k) * inv[0], 0.0))
    if se < 1e-12:
        return None
    return beta[0] / se, sse, m


def adf_p(series: list[float]) -> float:
    n = len(series)
    if n < 20:
        return 1.0
    maxlag = int(math.ceil(12.0 * (n / 100.0) ** 0.25))
    maxlag = max(0, min(maxlag, 6, n // 2 - 2))
    start = maxlag + 1
    best_t = None
    best_ic = float("inf")
    for lags in range(maxlag + 1):
        fit = _adf_t(series, lags, start)
        if not fit:
            continue
        tstat, sse, m = fit
        ic = m * math.log(max(sse, 1e-18) / m) + 2 * (lags + 1)
        if ic < best_ic:
            best_ic = ic
            best_t = tstat
    if best_t is None:
        return 1.0
    return _mackinnon_p(best_t)


def coint_age_bars(series: list[float], limit: float = 0.12, win: int = 80, step: int = 40) -> int:
    # Сколько баров подряд до текущего конца окна ещё проходят тест.
    n = len(series)
    if n < win:
        return 0
    oldest = None
    start = n - win
    while True:
        if adf_p(series[start:start + win]) > limit:
            break
        oldest = start
        if start == 0:
            break
        start = max(0, start - step)
    return 0 if oldest is None else n - oldest


def half_life(spread: list[float]) -> float:
    if len(spread) < 20:
        return 999.0
    y = [spread[i] - spread[i - 1] for i in range(1, len(spread))]
    x = spread[:-1]
    _, b = ols(x, y)
    if b >= 0 or b <= -1:
        return 999.0
    return math.log(2) / -math.log(1 + b)


def z_scores(spread: list[float]) -> list[float]:
    n = len(spread)
    if not n:
        return []
    mean = sum(spread) / n
    var = sum((v - mean) ** 2 for v in spread) / n
    sd = math.sqrt(max(var, 1e-12))
    return [(v - mean) / sd for v in spread]


def mean_revert(z: list[float], ts: list[int], z_entry: float, z_exit: float, bar_hours: float) -> dict:
    open_i = None
    closed = []
    last = None
    for i, v in enumerate(z):
        absz = abs(v)
        if open_i is None and absz >= z_entry:
            open_i = i
            last = {
                "entryTs": ts[i],
                "exitTs": None,
                "entryZ": v,
                "exitZ": None,
                "hours": None,
                "maxAdverseZ": absz,
                "reverted": False,
            }
            continue
        if open_i is not None:
            last["maxAdverseZ"] = max(last["maxAdverseZ"], absz)
            if absz <= z_exit:
                hours = (i - open_i) * bar_hours
                last = {
                    "entryTs": ts[open_i],
                    "exitTs": ts[i],
                    "entryZ": z[open_i],
                    "exitZ": v,
                    "hours": hours,
                    "maxAdverseZ": last["maxAdverseZ"],
                    "reverted": True,
                }
                closed.append(hours)
                open_i = None
    total = len(closed) + (1 if open_i is not None else 0)
    if not total:
        return {"winRate": 0, "trades": 0, "avgHours": 0, "last": last}
    return {
        "winRate": len(closed) / total,
        "trades": total,
        "avgHours": sum(closed) / len(closed) if closed else 0,
        "last": last,
    }


def align(x: list[tuple[int, float]], y: list[tuple[int, float]]):
    # Общие свечи. Дальше спред считается как Y - (a + b X).
    other = {t: c for t, c in y}
    xs, ys, ts = [], [], []
    for t, c in x:
        py = other.get(t)
        if py and c > 0 and py > 0:
            xs.append(c)
            ys.append(py)
            ts.append(t)
    return xs, ys, ts
