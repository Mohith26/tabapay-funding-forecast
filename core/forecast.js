// Funding Forecast core: how much to hold in a prefunded (FBO) payout account so that
// instant payouts do not run out of money before the next business-day funding lands.
//
// 1. Daily model: weighted ridge regression of log daily payout volume on calendar facts
//    (trend, weekday, payday, day after payday, month start, Fed holiday, day before a holiday),
//    recent days weighted more (half-life 91 days), plus an AR(1) carry of the latest residual.
// 2. Hourly shape: per-weekday median intraday shares over the trailing 6 weeks.
// 3. Window forecast R̂ = sum of hourly forecasts between funding landings, with an analytic
//    log-scale error sigma from the AR(1) residual covariance across the days the window spans.
// 4. Calibration: normalized split conformal on s = log(R/R̂)/sigma over the most recent
//    completed windows, with adaptive conformal inference (Gibbs & Candes 2021) on the level
//    (step size gamma = 0.1 * alpha so a single miss moves a 1% target by 0.1 points).
//    Recommended balance = R̂ * exp(q * sigma). Conformal p-values give daily-limit risk.
import { makeCalendar } from './calendar.js';

export const DEFAULTS = {
  regDays: 364, minRegDays: 182, halfLife: 91, ridge: 0.3,
  shareWeeks: 6, nCal: 250, minCal: 100, gammaRel: 0.1, ruleDays: 7,
};

// ---------- small linear algebra ----------
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular system');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function weightedRidge(X, y, w, penalty) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let j = 0; j < p; j++) {
      b[j] += w[i] * xi[j] * y[i];
      for (let k = j; k < p; k++) A[j][k] += w[i] * xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    A[j][j] += penalty[j];
  }
  return solve(A, b);
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Split-conformal upper quantile with the finite-sample correction.
// Returns { q, certified }: certified=false when ceil((n+1)(1-alpha)) > n.
export function conformalQuantile(scores, alpha) {
  const n = scores.length;
  const s = [...scores].sort((a, b) => a - b);
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return { q: s[n - 1], certified: false, k, n };
  if (k < 1) return { q: s[0], certified: true, k: 1, n };
  return { q: s[k - 1], certified: true, k, n };
}

// Conformal p-value that a new score is >= s* (probability of exceeding a threshold).
export function exceedProbability(scores, sStar) {
  let c = 0;
  for (const s of scores) if (s >= sStar) c++;
  return (c + 1) / (scores.length + 1);
}

// ---------- model ----------
const FEATS = ['intercept', 'trend', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'payday', 'afterPayday', 'monthStart', 'holidayMajor', 'holidayMinor', 'preHoliday'];

export function createModel(data, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const meta = data.meta;
  const cal = makeCalendar(meta);
  const y = Float64Array.from(data.hourly);
  const H = y.length;
  const nDays = Math.floor(H / 24);
  const D = new Float64Array(nDays);
  for (let d = 0; d < nDays; d++) { let s = 0; for (let h = 0; h < 24; h++) s += y[d * 24 + h]; D[d] = s; }

  const featRow = (d) => {
    const f = cal.flags(d);
    const r = [1, d / 365];
    for (let w = 1; w <= 6; w++) r.push(f.dow === w ? 1 : 0);
    const major = f.holiday && cal.isMajorHoliday(d) ? 1 : 0;
    r.push(f.payday, f.afterPayday, f.monthStart, major, f.holiday && !major ? 1 : 0, f.preHoliday);
    return r;
  };
  const penalty = FEATS.map((n, i) => (i < 8 ? 1e-6 : o.ridge));

  // Fit everything knowable at decision hour T (uses only hours < T).
  function fitAt(T) {
    const lastDay = Math.floor(T / 24) - 1; // last complete day
    const firstDay = Math.max(0, lastDay - o.regDays + 1);
    if (lastDay - firstDay + 1 < o.minRegDays) return null;
    const X = [], ly = [], w = [];
    for (let d = firstDay; d <= lastDay; d++) {
      X.push(featRow(d)); ly.push(Math.log(D[d]));
      w.push(Math.pow(0.5, (lastDay - d) / o.halfLife));
    }
    const beta = weightedRidge(X, ly, w, penalty);
    const res = X.map((x, i) => ly[i] - x.reduce((s, v, j) => s + v * beta[j], 0));
    // AR(1) on the last 26 weeks of residuals.
    const r0 = Math.max(1, res.length - 182);
    let num = 0, den = 0;
    for (let i = r0; i < res.length; i++) { num += res[i] * res[i - 1]; den += res[i - 1] * res[i - 1]; }
    const phi = Math.min(0.95, Math.max(0, num / den));
    let ss = 0, cnt = 0;
    for (let i = r0; i < res.length; i++) { const u = res[i] - phi * res[i - 1]; ss += u * u; cnt++; }
    const sigU = Math.sqrt(ss / Math.max(1, cnt - 1));
    // Intraday shares per weekday (median share over trailing weeks, renormalized).
    const shares = [];
    let hrSS = 0, hrN = 0;
    for (let wd = 0; wd < 7; wd++) {
      const perHour = Array.from({ length: 24 }, () => []);
      for (let d = lastDay; d > lastDay - 7 * o.shareWeeks && d >= 0; d--) {
        if (cal.dow(d) !== wd) continue;
        for (let h = 0; h < 24; h++) perHour[h].push(y[d * 24 + h] / D[d]);
      }
      const med = perHour.map(median);
      const s = med.reduce((a, b) => a + b, 0);
      shares.push(med.map((v) => v / s));
    }
    for (let d = lastDay; d > lastDay - 7 * o.shareWeeks && d >= 0; d--) {
      const sh = shares[cal.dow(d)];
      for (let h = 0; h < 24; h++) { const e = Math.log(y[d * 24 + h] / (D[d] * sh[h])); hrSS += e * e; hrN++; }
    }
    const sigHr = Math.sqrt(hrSS / hrN);
    return { T, lastDay, beta, phi, sigU, eLast: res[res.length - 1], shares, sigHr };
  }

  const logDayForecast = (fit, d) => {
    const x = featRow(d);
    const k = d - fit.lastDay;
    return x.reduce((s, v, j) => s + v * fit.beta[j], 0) + Math.pow(fit.phi, k) * fit.eLast;
  };

  // Forecast the total outflow over hours [a, b) from fit; returns R̂, sigma and the hourly path.
  function windowForecast(fit, a, b) {
    const hourly = [];
    const dayW = new Map();
    let R = 0;
    for (let t = a; t < b; t++) {
      const d = Math.floor(t / 24), h = t % 24;
      const v = Math.exp(logDayForecast(fit, d)) * fit.shares[cal.dow(d)][h];
      hourly.push(v); R += v;
      dayW.set(d, (dayW.get(d) || 0) + v);
    }
    const ds = [...dayW.keys()];
    let v = 0;
    for (const di of ds) for (const dj of ds) {
      const ki = di - fit.lastDay, kj = dj - fit.lastDay;
      let c = 0;
      for (let m = 1; m <= Math.min(ki, kj); m++) c += Math.pow(fit.phi, ki - m) * Math.pow(fit.phi, kj - m);
      v += (dayW.get(di) / R) * (dayW.get(dj) / R) * c * fit.sigU * fit.sigU;
    }
    let hv = 0;
    for (const x of hourly) hv += (x / R) * (x / R);
    v += hv * fit.sigHr * fit.sigHr;
    return { R, sigma: Math.sqrt(v), hourly };
  }

  const actual = (a, b) => { let s = 0; for (let t = a; t < b; t++) s += y[t]; return s; };
  const ruleBalance = (T, a, b) => {
    const lastDay = Math.floor(T / 24) - 1;
    let s = 0; for (let d = lastDay - o.ruleDays + 1; d <= lastDay; d++) s += D[d];
    return (s / o.ruleDays) * ((b - a) / 24);
  };

  // Funding windows: [09:00 on a business day, 09:00 on the next business day).
  const fh = meta.fundingHour;
  function windowsFrom(day0, count) {
    const out = [];
    let d = day0;
    while (!cal.isBusinessDay(d)) d++;
    while (out.length < count) {
      const n = cal.nextBusinessDay(d);
      const spans = [];
      for (let x = d; x < n; x++) spans.push(x);
      out.push({ day: d, next: n, a: d * 24 + fh, b: n * 24 + fh, T: d * 24 + 6, holiday: spans.some((x) => cal.isHoliday(x)), days: (n - d) });
      d = n;
    }
    return out;
  }
  const kind = (w) => (w.holiday ? 'holiday' : w.days >= 3 ? 'weekend' : 'overnight');

  // ---------- history: forecasts and scores for every past window ----------
  const asOf = meta.asOfHour;
  const history = [];
  {
    let d = 0;
    while (true) {
      const [w] = windowsFrom(d, 1);
      if (w.b > asOf) break;
      const fit = fitAt(w.T);
      if (fit) {
        const f = windowForecast(fit, w.a, w.b);
        const R = actual(w.a, w.b);
        history.push({ ...w, kind: kind(w), Rhat: f.R, sigma: f.sigma, R, score: Math.log(R / f.R) / f.sigma, rule: ruleBalance(w.T, w.a, w.b) });
      }
      d = w.next;
    }
  }
  // Daily-limit days [03:00 d, 03:00 d+1), forecast at 06:00 on day d-1.
  const lc = meta.limitCutoffHour;
  const limitHistory = [];
  for (let d = 1; (d + 1) * 24 + lc <= asOf; d++) {
    const T = (d - 1) * 24 + 6;
    const fit = fitAt(T);
    if (!fit) continue;
    const f = windowForecast(fit, d * 24 + lc, (d + 1) * 24 + lc);
    const R = actual(d * 24 + lc, (d + 1) * 24 + lc);
    limitHistory.push({ day: d, end: (d + 1) * 24 + lc, Rhat: f.R, sigma: f.sigma, R, score: Math.log(R / f.R) / f.sigma });
  }

  // ---------- calibrated policy for a target miss rate ----------
  function calibrate(alpha) {
    const rows = [];
    for (let j = 0; j < history.length; j++) {
      const w = history[j];
      const done = history.filter((h) => h.b <= w.T);
      if (done.length < o.minCal) continue;
      // ACI level from every outcome known before this decision.
      let aEff = alpha;
      for (const r of rows) if (r.b <= w.T) aEff += o.gammaRel * alpha * (alpha - (r.miss ? 1 : 0));
      const cal = done.slice(-o.nCal).map((h) => h.score);
      const cq = conformalQuantile(cal, Math.max(1e-4, Math.min(0.5, aEff)));
      const rec = w.Rhat * Math.exp(cq.q * w.sigma);
      rows.push({ ...w, aEff, q: cq.q, certified: cq.certified, rec, miss: w.R > rec });
    }
    return rows;
  }

  function summarize(rows, balanceOf) {
    let miss = 0, idle = 0, worst = 0, shortSum = 0;
    for (const r of rows) {
      const B = balanceOf(r);
      if (r.R > B) { miss++; worst = Math.max(worst, r.R - B); shortSum += r.R - B; } else idle += B - r.R;
    }
    return { n: rows.length, miss, rate: miss / rows.length, idle: idle / rows.length, worst, shortSum };
  }

  function backtest(alpha) {
    const rows = calibrate(alpha);
    const fc = summarize(rows, (r) => r.rec);
    const rule = summarize(rows, (r) => r.rule);
    const habit = summarize(rows, (r) => r.rule * meta.habit);
    // Smallest flat multiplier on the one-day rule that is short no more often than the forecast.
    let match = null;
    for (let c = 1.0; c <= 4.0001; c += 0.01) {
      const s = summarize(rows, (r) => r.rule * c);
      if (s.miss <= fc.miss) { match = { c: Math.round(c * 100) / 100, ...s }; break; }
    }
    const byKind = {};
    for (const k of ['overnight', 'weekend', 'holiday']) {
      const sub = rows.filter((r) => r.kind === k);
      byKind[k] = { n: sub.length, fc: summarize(sub, (r) => r.rec), habit: summarize(sub, (r) => r.rule * meta.habit), rule: summarize(sub, (r) => r.rule) };
    }
    const last = rows[rows.length - 1];
    let aNow = alpha;
    for (const r of rows) aNow += o.gammaRel * alpha * (alpha - (r.miss ? 1 : 0));
    return { rows, fc, rule, habit, match, byKind, aNow, first: rows[0], last };
  }

  // ---------- forward plan from the as-of decision ----------
  function plan(alpha, count = 12) {
    const bt = backtest(alpha);
    const T = asOf;
    const fit = fitAt(T);
    const done = history.filter((h) => h.b <= T);
    const calScores = done.slice(-o.nCal).map((h) => h.score);
    const aEff = Math.max(1e-4, Math.min(0.5, bt.aNow));
    const cq = conformalQuantile(calScores, aEff);
    const day0 = Math.floor(T / 24);
    const wins = windowsFrom(day0, count).map((w) => {
      const f = windowForecast(fit, w.a, w.b);
      const rec = f.R * Math.exp(cq.q * f.sigma);
      const rule = ruleBalance(T, w.a, w.b);
      return { ...w, kind: kind(w), Rhat: f.R, sigma: f.sigma, rec, rule, hourly: f.hourly };
    });
    // Daily-limit risk per limit day covered by the plan.
    const limScores = limitHistory.filter((l) => l.end <= T).slice(-o.nCal).map((l) => l.score);
    const limitDays = [];
    const lastB = wins[wins.length - 1].b;
    for (let d = day0; d * 24 + lc < lastB; d++) {
      const a = d * 24 + lc, b = a + 24;
      if (b <= T) continue;
      const f = windowForecast(fit, Math.max(a, T), b);
      const used = a < T ? actual(a, T) : 0;
      const remaining = meta.dailyPushLimit - used;
      const sStar = Math.log(remaining / f.R) / f.sigma;
      limitDays.push({ day: d, a, b, Rhat: f.R + used, used, p: exceedProbability(limScores, sStar), useMedianPct: (f.R + used) / meta.dailyPushLimit });
    }
    for (const w of wins) {
      const covered = limitDays.filter((l) => l.b > w.a && l.a < w.b);
      w.limit = covered.reduce((m, l) => (l.p > m.p ? l : m), { p: 0 });
    }
    // Hourly band for the first windows: per-prefix calibrated quantile using the same score scale.
    const pathFor = (w) => {
      const pts = [];
      let cum = 0;
      for (let i = 0; i < w.hourly.length; i++) {
        cum += w.hourly[i];
        const f = windowForecast(fit, w.a, w.a + i + 1);
        pts.push({ t: w.a + i + 1, med: cum, hi: cum * Math.exp(cq.q * f.sigma) });
      }
      return pts;
    };
    // Current balance from the client's habit (top up to habit x rule each business morning).
    const balance = simulateHabit(T);
    return { T, fit, cq, aEff, wins, limitDays, pathFor, balance, bt, calN: calScores.length, limN: limScores.length };
  }

  function simulateHabit(T) {
    const startDay = Math.floor(T / 24) - 21;
    let bal = meta.openingBalance;
    const path = [];
    let declined = 0;
    for (let t = startDay * 24; t < T; t++) {
      const d = Math.floor(t / 24), h = t % 24;
      if (h === fh && cal.isBusinessDay(d)) {
        const n = cal.nextBusinessDay(d);
        const target = ruleBalance(d * 24 + 6, d * 24 + fh, n * 24 + fh) * meta.habit;
        if (bal < target) bal = target;
      }
      const out = Math.min(bal, y[t]);
      declined += y[t] - out;
      bal -= out;
      path.push({ t: t + 1, bal });
    }
    return { now: bal, path, declined };
  }

  return { meta, cal, y, D, nDays, fitAt, windowForecast, windowsFrom, history, limitHistory, calibrate, backtest, plan, ruleBalance, actual, opts: o, FEATS };
}
