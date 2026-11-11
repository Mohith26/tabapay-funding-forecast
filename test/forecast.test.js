import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve, weightedRidge, conformalQuantile, exceedProbability, median, createModel } from '../core/forecast.js';
import { makeCalendar } from '../core/calendar.js';

const data = JSON.parse(readFileSync(new URL('../data/flows.json', import.meta.url)));

test('solve: 3x3 system', () => {
  const x = solve([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
  [2, 3, -1].forEach((v, i) => assert.ok(Math.abs(x[i] - v) < 1e-9));
});

test('weightedRidge recovers noiseless coefficients with tiny penalty', () => {
  const X = [], y = [], w = [];
  for (let i = 0; i < 50; i++) { const r = [1, i / 10, i % 3 === 0 ? 1 : 0]; X.push(r); y.push(2 - 0.5 * r[1] + 0.3 * r[2]); w.push(Math.pow(0.5, (50 - i) / 10)); }
  const b = weightedRidge(X, y, w, [1e-9, 1e-9, 1e-9]);
  [2, -0.5, 0.3].forEach((v, i) => assert.ok(Math.abs(b[i] - v) < 1e-6));
});

test('conformalQuantile uses the ceil((n+1)(1-a)) order statistic and flags uncertifiable levels', () => {
  const s = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99
  assert.deepEqual([conformalQuantile(s, 0.1).q, conformalQuantile(s, 0.1).k], [90, 90]);
  const r = conformalQuantile(s, 0.005); // needs k = 100 > 99
  assert.equal(r.certified, false);
  assert.equal(r.q, 99);
});

test('split conformal covers at the nominal rate on exchangeable scores', () => {
  let a = 7; const rnd = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let miss = 0, trials = 4000;
  for (let t = 0; t < trials; t++) {
    const cal = Array.from({ length: 150 }, randn);
    if (randn() > conformalQuantile(cal, 0.05).q) miss++;
  }
  const rate = miss / trials;
  assert.ok(rate <= 0.05 + 0.012 && rate >= 0.05 - 0.02, `miss rate ${rate}`);
});

test('exceedProbability is a conformal p-value', () => {
  assert.equal(exceedProbability([1, 2, 3, 4], 3.5), 2 / 5);
  assert.equal(exceedProbability([1, 2, 3, 4], 10), 1 / 5);
  assert.equal(median([3, 1, 2, 10]), 2.5);
});

test('calendar: Veterans Day and Thanksgiving gaps, biweekly paydays', () => {
  const cal = makeCalendar(data.meta);
  const d = (s) => cal.dayOf(s);
  assert.equal(cal.isBusinessDay(d('2026-11-11')), false);
  assert.equal(cal.dateOf(cal.nextBusinessDay(d('2026-11-10'))), '2026-11-12');
  assert.equal(cal.dateOf(cal.nextBusinessDay(d('2026-11-25'))), '2026-11-27');
  assert.equal(cal.dateOf(cal.nextBusinessDay(d('2026-11-13'))), '2026-11-16');
  assert.ok(cal.isPayday(d('2026-11-13')) && cal.isPayday(d('2026-11-27')) && !cal.isPayday(d('2026-11-20')));
});

const model = createModel(data);

test('funding windows tile time without gaps or overlaps', () => {
  const w = model.windowsFrom(model.cal.dayOf('2026-11-10'), 12);
  for (let i = 1; i < w.length; i++) assert.equal(w[i].a, w[i - 1].b);
  assert.equal(w[0].b - w[0].a, 48); // Tue 09:00 -> Thu 09:00 over Veterans Day
});

test('window forecast: hourly path sums to the total and sigma is positive', () => {
  const fit = model.fitAt(data.meta.asOfHour);
  const f = model.windowForecast(fit, data.meta.asOfHour + 3, data.meta.asOfHour + 51);
  assert.ok(Math.abs(f.hourly.reduce((a, b) => a + b, 0) - f.R) < 1e-6 * f.R);
  assert.ok(f.sigma > 0 && f.sigma < 1);
});

test('no look-ahead: changing data after the decision hour does not change the forecast', () => {
  const T = data.meta.asOfHour - 24 * 30;
  const f1 = model.windowForecast(model.fitAt(T), T + 3, T + 27);
  const mutated = { meta: data.meta, hourly: data.hourly.map((v, i) => (i >= T ? v * 3 : v)) };
  const m2 = createModel(mutated);
  const f2 = m2.windowForecast(m2.fitAt(T), T + 3, T + 27);
  assert.equal(f1.R, f2.R);
  assert.equal(f1.sigma, f2.sigma);
});

test('backtest: realized shortfall rate tracks the target and recommendations rise as the target tightens', () => {
  const b1 = model.backtest(0.01), b5 = model.backtest(0.05);
  assert.ok(b1.fc.n > 200);
  assert.ok(b1.fc.rate <= 0.025, `1% target realized ${b1.fc.rate}`);
  assert.ok(Math.abs(b5.fc.rate - 0.05) <= 0.025, `5% target realized ${b5.fc.rate}`);
  assert.ok(b1.fc.idle > b5.fc.idle);
  assert.ok(b1.match.miss <= b1.fc.miss && b1.match.c >= 1);
  const p1 = model.plan(0.01), p5 = model.plan(0.05);
  p1.wins.forEach((w, i) => assert.ok(w.rec > p5.wins[i].rec));
});

test('plan: limit risk is a probability and the habit balance is non-negative', () => {
  const p = model.plan(0.01);
  for (const l of p.limitDays) assert.ok(l.p > 0 && l.p <= 1);
  assert.ok(p.balance.now >= 0);
  assert.equal(p.wins.length, 12);
});
