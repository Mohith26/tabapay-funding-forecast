// Prints the numbers the demo shows (same code path as the page).
import { readFileSync } from 'node:fs';
import { createModel } from '../core/forecast.js';
import { labelDay } from '../core/calendar.js';

const data = JSON.parse(readFileSync(new URL('../data/flows.json', import.meta.url)));
const t0 = Date.now();
const m = createModel(data);
const alpha = Number(process.argv[2] || 0.01);
const p = m.plan(alpha);
const M = (x) => `$${(x / 1e6).toFixed(2)}M`;
const bt = p.bt;
console.log(`history windows=${m.history.length} backtest windows=${bt.fc.n} (${labelDay(m.cal, bt.first.day).mdy}..${labelDay(m.cal, bt.last.day).mdy}) limitDays=${m.limitHistory.length} ms=${Date.now() - t0}`);
console.log(`fit: phi=${p.fit.phi.toFixed(3)} sigU=${p.fit.sigU.toFixed(3)} sigHr=${p.fit.sigHr.toFixed(3)} aNow=${bt.aNow.toFixed(4)} q=${p.cq.q.toFixed(3)} certified=${p.cq.certified} calN=${p.calN}`);
console.log(m.FEATS.map((f, i) => `${f}=${p.fit.beta[i].toFixed(3)}`).join(' '));
for (const [k, s] of Object.entries({ forecast: bt.fc, rule: bt.rule, habit: bt.habit, match: bt.match })) {
  console.log(`${k.padEnd(9)} miss=${s.miss}/${s.n} rate=${(s.rate * 100).toFixed(1)}% idle=${M(s.idle)} worst=${M(s.worst)} ${s.c ? 'c=' + s.c : ''}`);
}
console.log(`idle saving vs matched buffer: ${((1 - bt.fc.idle / bt.match.idle) * 100).toFixed(1)}%`);
for (const [k, v] of Object.entries(bt.byKind)) console.log(`  ${k}: n=${v.n} fcMiss=${v.fc.miss} habitMiss=${v.habit.miss} ruleMiss=${v.rule.miss}`);
console.log(`balance now ${M(p.balance.now)} declined(21d) ${M(p.balance.declined)}`);
for (const w of p.wins) {
  const l = labelDay(m.cal, w.day), n = labelDay(m.cal, w.next);
  console.log(`${l.dow} ${l.md} -> ${n.dow} ${n.md} ${w.kind.padEnd(9)} Rhat=${M(w.Rhat)} rec=${M(w.rec)} rule=${M(w.rule)} sig=${w.sigma.toFixed(3)} limitP=${(w.limit.p * 100).toFixed(0)}%`);
}
