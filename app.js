import { createModel, exceedProbability } from './core/forecast.js';
import { labelDay } from './core/calendar.js';

const $ = (id) => document.getElementById(id);
const usd = (x, dp = 2) => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usdM = (x) => (x < 0 ? '-' : '') + '$' + (Math.abs(x) / 1e6).toFixed(2) + 'M';
const pct = (p, dp = 1) => (p * 100).toFixed(dp) + '%';
const HOLIDAY_NAMES = { '2026-11-11': 'Veterans Day', '2026-11-26': 'Thanksgiving', '2026-12-25': 'Christmas', '2027-01-01': "New Year's Day" };
const ALPHAS = [0.005, 0.01, 0.02, 0.05];

const data = await (await fetch('data/flows.json')).json();
const model = createModel(data);
const { meta, cal } = model;
const T = meta.asOfHour;
const qs = new URLSearchParams(location.search);
let alpha = ALPHAS.includes(Number(qs.get('a'))) ? Number(qs.get('a')) : 0.01;
let sel = Math.min(11, Math.max(0, Number(qs.get('w')) || 0));
const cache = new Map();
const getPlan = (a) => { if (!cache.has(a)) cache.set(a, model.plan(a)); return cache.get(a); };

const hourLabel = (t) => {
  const d = Math.floor(t / 24), h = t % 24;
  const L = labelDay(cal, d);
  const hh = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
  return { L, hh, full: `${L.dow} ${L.md} ${String(h).padStart(2, '0')}:00 PT` };
};
const winLabel = (w) => { const a = labelDay(cal, w.day), b = labelDay(cal, w.next); return { a, b, text: `${a.dow} ${a.md} 09:00 → ${b.dow} ${b.md} 09:00 PT` }; };
function tags(w) {
  const out = [];
  for (let d = w.day; d < w.next; d++) {
    const ds = cal.dateOf(d);
    if (cal.isHoliday(d)) out.push(`<span class="tag hol">${HOLIDAY_NAMES[ds] || 'Fed holiday'}</span>`);
    if (cal.isPayday(d)) out.push('<span class="tag pay">Payday</span>');
    if (cal.dom(d) === 1) out.push('<span class="tag">Month start</span>');
  }
  if (w.kind === 'weekend' || (w.kind === 'holiday' && w.days >= 3)) out.unshift('<span class="tag">Weekend</span>');
  return out.join('') || '<span class="muted">--</span>';
}
function riskBadge(p, hi = 0.1, mid = 0.03) {
  const cls = p >= hi ? 'b-r' : p >= mid ? 'b-o' : 'b-g';
  const txt = p < 0.01 ? '&lt;1%' : p >= 0.995 ? '&gt;99%' : pct(p, 0);
  return `<span class="badge ${cls}">${txt}</span>`;
}

function render() {
  const P = getPlan(alpha);
  const cq = P.cq;
  const calScores = model.history.filter((h) => h.b <= T).slice(-model.opts.nCal).map((h) => h.score);
  const w0 = P.wins[0];
  const lab0 = winLabel(w0);

  // Refresh + account card
  const utc = (T % 24) + 8;
  $('refresh').innerHTML = `Last Refresh: ${labelDay(cal, Math.floor(T / 24)).mdy} ${String(utc).padStart(2, '0')}:00 UTC <i class="ti ti-refresh"></i>`;
  const cutoff = Math.floor(T / 24) * 24 + meta.limitCutoffHour;
  const pending = model.actual(cutoff, T);
  const avail = P.balance.now;
  $('acct').innerHTML = `<div class="acct-strip"><span class="pill">ISO: <b>${meta.iso}</b><span class="dash"></span>MID: <b>${meta.mid}</b></span><span class="pill">FBO · Payouts</span></div>
    <div class="acct-body"><div class="kv">Account Number:<b>•••${meta.accountLast4}</b><br>Routing Number:<b>${meta.routing}</b></div>
    <div class="bal"><div class="l">Current Balance</div><div class="v">${usd(avail + pending).slice(1)}&nbsp; USD</div></div>
    <div class="bal"><div class="l">Available Balance</div><div class="v">${usd(avail).slice(1)}&nbsp; USD</div></div></div>`;
  $('ff-sub').textContent = `Payout FBO •••${meta.accountLast4} · forecast at 06:00 PT for funds landing 09:00 PT`;
  $('alpha').innerHTML = ALPHAS.map((a) => `<button data-a="${a}" class="${a === alpha ? 'on' : ''}">${a * 100}%</button>`).join('');
  $('alpha').querySelectorAll('button').forEach((b) => (b.onclick = () => { alpha = Number(b.dataset.a); render(); }));

  // Today's funding
  const pre = model.windowForecast(P.fit, T, w0.a).R;
  const topUp = Math.max(0, w0.rec + pre - avail);
  const pRule0 = exceedProbability(calScores, Math.log(w0.rule / w0.Rhat) / w0.sigma);
  const hol = [];
  for (let d = w0.day + 1; d < w0.next; d++) if (cal.isHoliday(d)) hol.push(`${labelDay(cal, d).dow} ${labelDay(cal, d).md} is ${HOLIDAY_NAMES[cal.dateOf(d)] || 'a Fed holiday'}`);
  const why = hol.length ? `${hol.join(', ')}: the Fed is closed, so no wire can land until ${lab0.b.dow} ${lab0.b.md}.` : `Next funding lands ${lab0.b.dow} ${lab0.b.md} 09:00 PT.`;
  const cert = cq.certified ? '' : `<div class="callout" style="margin-top:8px">A ${pct(alpha, 1)} target needs at least ${Math.ceil(1 / alpha) - 1} completed windows to certify; only ${P.calN} are in the calibration set, so this uses the largest observed error (not certified).</div>`;
  $('today').innerHTML = `<div class="eyebrow">Today · ${lab0.a.dow} ${lab0.a.mdy} · send funds by 09:00 PT</div>
    <div class="big">${usd(topUp)}<span class="ccy">USD</span></div>
    <div class="note">Top-up needed to cover payouts until <b>${lab0.b.dow} ${lab0.b.md} 09:00 PT</b>, targeting a <b>${pct(alpha, alpha < 0.01 ? 1 : 0)}</b> chance of running short. ${why}</div>
    <table class="mini">
      <tr><td><span class="dot" style="background:var(--violet)"></span>Forecast payouts, ${lab0.a.dow} 09:00 → ${lab0.b.dow} 09:00</td><td>${usd(w0.Rhat)}</td></tr>
      <tr><td><span class="dot" style="background:#b4a9f6"></span>Calibrated buffer (+${pct(w0.rec / w0.Rhat - 1, 1)})</td><td>${usd(w0.rec - w0.Rhat)}</td></tr>
      <tr><td><span class="dot" style="background:var(--orange)"></span>Payouts before funds land (06:00 → 09:00)</td><td>${usd(pre)}</td></tr>
      <tr><td><span class="dot" style="background:var(--teal)"></span>Available balance now</td><td>−${usd(avail)}</td></tr>
      <tr class="tot"><td>Top-up needed</td><td>${usd(topUp)}</td></tr>
      <tr class="rule"><td>One-day rule (7-day average × ${w0.days} days) would hold ${usd(w0.rule)}</td><td>${riskBadge(pRule0)} <span class="muted" style="font-size:12.5px">chance short</span></td></tr>
    </table>${cert}`;

  // Daily limit gauge: riskiest limit day in the plan horizon (next 7 days).
  const horizon = P.limitDays.filter((l) => l.a < T + 7 * 24);
  const top = horizon.reduce((m, l) => (l.p > m.p ? l : m), horizon[0]);
  const td = labelDay(cal, top.day);
  const u = top.useMedianPct;
  $('limit').innerHTML = `<div class="eyebrow">Daily Push Limit · busiest day in the next 7</div>
    <div class="gauge-wrap">${gauge(u)}<div class="kvs">
      <div><div class="l">Projected Volume · ${td.dow} ${td.md}</div><div class="v">${usd(top.Rhat)} USD</div></div>
      <div><div class="l">Chance to Hit Limit</div><div class="v">${riskBadge(top.p)} <small>conformal, n=${P.limN}</small></div></div>
      <div><div class="l">Total Push Limit</div><div class="v">${usd(meta.dailyPushLimit)} USD</div></div></div></div>
    <div class="note" style="margin-top:6px">${top.p >= 0.1 ? `<b>${td.dow} ${td.md}</b> is a payday${cal.isHoliday(top.day - 1) ? ' after a holiday' : ''}: request a limit increase from Support before then, or late payouts will fail with <b>EM: Transaction Limit</b>.` : 'No day in the next week is likely to reach the daily limit.'} Limit days run 24 hours to the 03:00 PT Visa disbursement cutoff.</div>`;

  // Window selector
  $('winsel').innerHTML = P.wins.map((w, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${winLabel(w).text}</option>`).join('');
  $('winsel').onchange = (e) => { sel = Number(e.target.value); render(); };
  drawChart(P, P.wins[sel], sel === 0, avail, pre);

  // Funding calendar
  const rows = P.wins.map((w, i) => {
    const l = winLabel(w);
    const pr = exceedProbability(calScores, Math.log(w.rule / w.Rhat) / w.sigma);
    return `<tr data-i="${i}" class="${i === sel ? 'sel' : ''}"><td>${l.a.dow} ${l.a.mdy}</td><td>${l.b.dow} ${l.b.md} 09:00</td><td>${tags(w)}</td>
      <td class="num">${usd(w.Rhat)}</td><td class="num"><b>${usd(w.rec)}</b></td><td class="num muted">${usd(w.rule)}</td><td>${riskBadge(pr)}</td><td>${riskBadge(w.limit.p)}</td></tr>`;
  }).join('');
  $('cal').innerHTML = `<thead><tr><th>Funding Date</th><th>Covers Until</th><th>Calendar</th><th class="num">Forecast Payouts</th><th class="num">Recommended Balance</th><th class="num">One-Day Rule</th><th>Rule Short Risk</th><th>Limit Risk</th></tr></thead><tbody>${rows}</tbody>`;
  $('cal').querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => { sel = Number(tr.dataset.i); render(); }));

  // Backtest
  const B = P.bt;
  const f0 = labelDay(cal, B.first.day), f1 = labelDay(cal, B.last.day);
  $('bt-sub').textContent = `${B.fc.n} funding windows, ${f0.mdy} – ${f1.mdy}. Each decision used only data available at 06:00 PT that day.`;
  const line = (name, s, cls = '') => `<tr class="${cls}"><td>${name}</td><td class="num">${s.miss} of ${s.n}</td><td class="num">${pct(s.rate)}</td><td class="num">${usdM(s.idle)}</td><td class="num">${s.miss ? usdM(s.worst) : '--'}</td></tr>`;
  const saving = 1 - B.fc.idle / B.match.idle;
  $('bt-main').innerHTML = `<h4>Shortfalls and idle cash by funding policy</h4><table class="tbl"><thead><tr><th>Policy</th><th class="num">Windows Short</th><th class="num">Short Rate</th><th class="num">Avg Unused Balance</th><th class="num">Largest Shortfall</th></tr></thead><tbody>
    ${line('One-day rule (7-day average × days covered)', B.rule)}
    ${line(`Current practice (${meta.habit}× one-day rule)`, B.habit)}
    ${line(`Flat buffer sized to match (${B.match.c.toFixed(2)}× one-day rule)`, B.match)}
    ${line(`Funding Forecast (${pct(alpha, alpha < 0.01 ? 1 : 0)} target)`, B.fc, 'hl')}</tbody></table>
    <div class="callout">At the same shortfall count, a flat buffer on the one-day rule had to hold <b>${usdM(B.match.idle)}</b> unused on average; Funding Forecast held <b>${usdM(B.fc.idle)}</b>, <b>${pct(saving, 0)} less idle cash</b>. The current practice ran short in ${B.habit.miss} windows, leaving an estimated <b>${usdM(B.habit.shortSum)}</b> of payouts unfunded.</div>`;
  const K = { overnight: 'Overnight (next business day)', weekend: 'Weekend (Fri → Mon)', holiday: 'Spans a Fed holiday' };
  $('bt-kind').innerHTML = `<div><h4>Realized shortfalls by window type</h4><table class="tbl"><thead><tr><th>Window</th><th class="num">Windows</th><th class="num">One-Day Rule</th><th class="num">Current Practice</th><th class="num">Funding Forecast</th></tr></thead><tbody>
    ${Object.entries(B.byKind).map(([k, v]) => `<tr><td>${K[k]}</td><td class="num">${v.n}</td><td class="num">${v.rule.miss} short</td><td class="num">${v.habit.miss} short</td><td class="num"><b>${v.fc.miss} short</b></td></tr>`).join('')}</tbody></table></div>
    <div class="note" style="padding-top:28px">Errors are scored on a normalized scale (log error ÷ the window's own σ), so weekend and holiday windows share one calibration set with overnight windows instead of each needing 100+ examples of their own. Adaptive conformal inference nudges the level after every outcome; it is now ${pct(B.aNow, 2)} for a ${pct(alpha, 1)} target.</div>`;

  // Method
  const fit = P.fit;
  const FE = model.FEATS;
  const coef = (n) => fit.beta[FE.indexOf(n)];
  const eff = (n) => pct(Math.exp(coef(n)) - 1, 0);
  $('how').innerHTML = `<p><b>1. Daily payout model.</b> Log daily payout volume is regressed on calendar facts known in advance (trend, weekday, payday, day after payday, month start, Fed holidays, day before a holiday) with weighted ridge regression over the last 52 weeks, recent weeks weighted more (91-day half-life). Today's fit: payday ${eff('payday')}, Friday ${eff('Fri')} vs Sunday, month start ${eff('monthStart')}. The latest residual carries forward as AR(1) (φ = ${fit.phi.toFixed(2)}).</p>
    <p><b>2. Hourly shape.</b> Each weekday's intraday share of volume is the median over the trailing 6 weeks, so a window that starts or ends at 09:00 PT gets the right fraction of each day.</p>
    <p><b>3. Window error scale.</b> σ for a window comes from the AR(1) covariance of the days it spans (σ<sub>u</sub> = ${fit.sigU.toFixed(3)}) plus hourly noise (${fit.sigHr.toFixed(3)}). A Fri → Mon window gets σ = ${P.wins.find((w) => w.kind === 'weekend').sigma.toFixed(3)}, an overnight one ${P.wins.find((w) => w.kind === 'overnight').sigma.toFixed(3)}.</p>
    <p><b>4. Calibration.</b> Split conformal on s = log(actual / forecast) / σ over the last ${P.calN} completed windows gives the multiplier: recommended balance = forecast × exp(q·σ), with q = ${cq.q.toFixed(2)} at level ${pct(P.aEff, 2)}. The model can be wrong; the conformal step makes the miss rate hold anyway, as long as recent errors resemble future ones.</p>
    <p><b>5. Daily limit risk.</b> The same model forecasts each 24-hour limit day; the conformal p-value of the remaining limit headroom gives the chance of hitting the ${usdM(meta.dailyPushLimit)} daily push limit.</p>
    <p><b>Assumptions.</b> Wires sent at the 06:00 PT decision land by 09:00 PT on business days; fees, ACH returns and representments are left out; volume above the limit is treated as demand. Synthetic data, seed ${meta.generator.seed}.</p>`;
}

// ---------- chart ----------
function drawChart(P, w, first, avail, pre) {
  const box = $('chart');
  const W = 1180, H = 320, m = { l: 64, r: 18, t: 26, b: 34 };
  const path = P.pathFor(w);
  const pts = [{ t: w.a, med: 0, hi: 0 }, ...path];
  const series = pts.map((p) => ({ t: p.t, med: w.rec - p.med, lo: w.rec - p.hi, rule: w.rule - p.hi }));
  let past = [];
  if (first) {
    past = P.balance.path.filter((p) => p.t >= w.a - 24);
  }
  const t0 = first ? w.a - 24 : w.a, t1 = w.b;
  const ys = [0, w.rec, ...series.map((s) => s.rule), ...past.map((p) => p.bal)];
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const step = niceStep((yMax - Math.min(0, yMin)) / 5);
  yMax = Math.ceil(yMax / step) * step;
  yMin = Math.min(0, Math.floor(yMin / step) * step);
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // non-business days shaded
  for (let d = Math.floor(t0 / 24); d * 24 < t1; d++) {
    if (cal.isBusinessDay(d)) continue;
    const a = Math.max(t0, d * 24), b = Math.min(t1, (d + 1) * 24);
    const name = HOLIDAY_NAMES[cal.dateOf(d)] || (cal.isHoliday(d) ? 'Fed holiday' : 'Weekend');
    s += `<rect x="${X(a)}" y="${m.t}" width="${X(b) - X(a)}" height="${H - m.t - m.b}" fill="#f6f6f8"/>`;
    s += `<text x="${(X(a) + X(b)) / 2}" y="${m.t + 14}" text-anchor="middle" class="ylab">${name} · no wires</text>`;
  }
  for (let v = yMin; v <= yMax + 1; v += step) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e7eb"/>`;
    s += `<text x="${m.l - 10}" y="${Y(v) + 4}" text-anchor="end" class="axis">${v === 0 ? '$0' : (v < 0 ? '-' : '') + '$' + Math.abs(v / 1e6).toFixed(step < 1e6 ? 1 : 0) + 'M'}</text>`;
  }
  for (let t = Math.ceil(t0 / 12) * 12; t <= t1; t += 12) {
    const hl = hourLabel(t);
    const lbl = t % 24 === 0 ? `${hl.L.dow} ${hl.L.short}` : '12 PM';
    s += `<text x="${X(t)}" y="${H - 10}" text-anchor="middle" class="axis" ${t % 24 ? 'fill="#8c92a0"' : ''}>${lbl}</text>`;
  }
  s += `<text transform="translate(14 ${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle" class="ylab">Available Balance</text>`;
  // band
  const band = series.map((p) => `${X(p.t)},${Y(p.med)}`).join(' ') + ' ' + [...series].reverse().map((p) => `${X(p.t)},${Y(p.lo)}`).join(' ');
  s += `<polygon points="${band}" fill="rgba(55,26,229,0.12)"/>`;
  s += `<polyline points="${series.map((p) => `${X(p.t)},${Y(p.rule)}`).join(' ')}" fill="none" stroke="#8c92a0" stroke-width="2" stroke-dasharray="6 5"/>`;
  s += `<polyline points="${series.map((p) => `${X(p.t)},${Y(p.lo)}`).join(' ')}" fill="none" stroke="#8b77f0" stroke-width="1.2"/>`;
  s += `<polyline points="${series.map((p) => `${X(p.t)},${Y(p.med)}`).join(' ')}" fill="none" stroke="#371ae5" stroke-width="2.2"/>`;
  if (first && past.length) {
    s += `<polyline points="${past.map((p) => `${X(p.t)},${Y(p.bal)}`).join(' ')}" fill="none" stroke="#b7bcc8" stroke-width="2"/>`;
    const tNow = past[past.length - 1].t;
    s += `<line x1="${X(tNow)}" x2="${X(w.a)}" y1="${Y(avail)}" y2="${Y(avail - pre)}" stroke="#b7bcc8" stroke-width="2" stroke-dasharray="3 3"/>`;
    s += `<line x1="${X(w.a)}" x2="${X(w.a)}" y1="${Y(avail - pre)}" y2="${Y(w.rec)}" stroke="#371ae5" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    s += `<circle cx="${X(tNow)}" cy="${Y(avail)}" r="4" fill="#fff" stroke="#8c92a0" stroke-width="2"/>`;
    s += `<text x="${X(tNow) - 6}" y="${Y(avail) - 10}" text-anchor="end" class="ylab">Now · ${usdM(avail)}</text>`;
    s += `<text x="${X(w.a) + 8}" y="${Y(w.rec) - 8}" class="ylab" style="fill:#10078f;font-weight:600">Funds land · ${usdM(w.rec)}</text>`;
  }
  // zero line + pill
  const zy = Y(0);
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${zy}" y2="${zy}" stroke="#f57d70" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`;
  const px = (m.l + W - m.r) / 2;
  s += `<rect x="${px - 104}" y="${zy - 13}" width="208" height="26" rx="13" fill="#fff" stroke="#f57d70" stroke-width="1.5"/><text x="${px}" y="${zy + 5}" text-anchor="middle" style="font-size:13px;font-weight:600;fill:#24272f">Payouts fail below $0.00</text>`;
  // where the one-day rule runs dry in the low path
  const dry = series.find((p) => p.rule < 0);
  if (dry) {
    s += `<circle cx="${X(dry.t)}" cy="${Y(0)}" r="5" fill="#e5484d"/>`;
    const hl = hourLabel(dry.t);
    const nearR = X(dry.t) > 420;
    s += `<text x="${X(dry.t) + (nearR ? -8 : 8)}" y="${Y(0) + 22}" text-anchor="${nearR ? 'end' : 'start'}" class="ylab" style="fill:#76241e;font-weight:600">One-day rule runs dry ${hl.L.dow} ${hl.hh} (low path)</text>`;
  }
  s += `<rect id="hover" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`;
  s += `<line id="vline" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="#c7cbd3" stroke-dasharray="3 3" visibility="hidden"/></svg>`;
  const tip = $('tip');
  box.innerHTML = s;
  box.appendChild(tip);
  const svg = box.querySelector('svg');
  const vline = svg.querySelector('#vline');
  svg.querySelector('#hover').addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const t = Math.round(t0 + ((x - m.l) / (W - m.l - m.r)) * (t1 - t0));
    const p = series.find((q) => q.t === t);
    const pp = past.find((q) => q.t === t);
    if (!p && !pp) { tip.style.display = 'none'; vline.setAttribute('visibility', 'hidden'); return; }
    vline.setAttribute('x1', X(t)); vline.setAttribute('x2', X(t)); vline.setAttribute('visibility', 'visible');
    const rows = p ? [['Projected balance', usd(p.med, 0)], [`Low path (${pct(alpha, alpha < 0.01 ? 1 : 0)} risk)`, usd(p.lo, 0)], ['One-day rule, low path', usd(p.rule, 0)]] : [['Actual available balance', usd(pp.bal, 0)]];
    tip.innerHTML = `<div class="t">${hourLabel(t).full}</div>` + rows.map(([a, b]) => `<div class="r">${a}<b>${b}</b></div>`).join('');
    tip.style.display = 'block';
    const left = ((X(t) / W) * r.width) + 18;
    tip.style.left = Math.min(left, r.width - 220) + 'px';
    tip.style.top = '40px';
  });
  svg.querySelector('#hover').addEventListener('mouseleave', () => { tip.style.display = 'none'; vline.setAttribute('visibility', 'hidden'); });
  $('legend').innerHTML = `<span><i class="lg-line"></i>Projected balance (median)</span><span><i class="lg-band"></i>Calibrated range to the ${pct(alpha, alpha < 0.01 ? 1 : 0)} low path</span><span><i class="lg-dash"></i>Funded with one-day rule (low path)</span>${first ? '<span><i class="lg-past"></i>Actual balance</span>' : ''}<span><i class="lg-dot"></i>Payouts fail</span>`;
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function gauge(u) {
  const cx = 105, cy = 100, r = 78;
  const ang = (f) => Math.PI * (1 - Math.min(1, Math.max(0, f)));
  const pt = (f) => [cx + r * Math.cos(ang(f)), cy - r * Math.sin(ang(f))];
  const arc = (f0, f1, color) => {
    if (f1 - f0 < 0.004) return '';
    const [x0, y0] = pt(f0), [x1, y1] = pt(f1);
    return `<path d="M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}" stroke="${color}" stroke-width="13" fill="none" stroke-linecap="round"/>`;
  };
  const v = Math.min(1, u);
  const split = Math.min(v, 0.6);
  let s = `<svg viewBox="0 0 210 132" width="210">`;
  s += arc(0.0, split - 0.03, '#00d7b0');
  if (v > 0.6) s += arc(0.6 + 0.0, v, '#fabc6b');
  if (v < 0.97) s += arc(Math.min(0.99, v + 0.05), 1, '#e5e7eb');
  const [mx, my] = pt(v);
  s += `<circle cx="${mx}" cy="${my}" r="6" fill="#fff" stroke="#e5e7eb" stroke-width="2"/>`;
  s += `<text x="${cx}" y="${cy - 14}" text-anchor="middle" class="gauge-num" style="fill:${v > 0.6 ? '#fa8f05' : '#019377'}">${Math.round(u * 100)}%</text>`;
  s += `<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="gauge-lbl">Projected Limit Use</text>`;
  s += `<text x="${cx - r}" y="${cy + 30}" text-anchor="middle" class="gauge-tick">0%</text><text x="${cx + r}" y="${cy + 30}" text-anchor="middle" class="gauge-tick">100%</text></svg>`;
  return s;
}

render();
