// Seeded synthetic data for one client's push-disbursement (payout) FBO account.
// Run: node scripts/generate.js  ->  data/flows.json
// Hourly payout dollars (PT wall clock) from Mon 2025-01-06 00:00 to the as-of hour.
import { writeFileSync } from 'node:fs';
import { makeCalendar } from '../core/calendar.js';

const SEED = 20261110;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const meta = {
  client: 'ACME', subclient: 'ACME 2', clientId: '1234567', subclientId: '90123456',
  bank: 'Cross River Bank', iso: '1200', mid: '4320', accountLast4: '1239', routing: '123456789',
  start: '2025-01-06',
  asOf: '2026-11-10T06:00', // Tue 06:00 PT: today's funding decision
  fundingHour: 9, // assumed: a wire sent at the 06:00 PT decision lands by 09:00 PT on business days
  limitCutoffHour: 3, // Visa disbursement cutoff 03:00 PT; the daily program limit counts 24h to cutoff
  dailyPushLimit: 5000000,
  paydayAnchor: '2025-01-10', // biweekly Friday payroll for the program's users
  fedHolidays: [
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
    '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12',
    '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01',
  ],
  majorHolidays: ['2025-01-01', '2025-07-04', '2025-11-27', '2025-12-25', '2026-01-01', '2026-11-26', '2026-12-25', '2027-01-01'],
  habit: 1.1, // the client's current practice: top up to 1.1x the one-day rule each business morning
  openingBalance: 2600000,
  generator: { seed: SEED },
};

const cal = makeCalendar(meta);
const [aDate, aTime] = meta.asOf.split('T');
const asOfHour = cal.dayOf(aDate) * 24 + Number(aTime.slice(0, 2));

// Ground-truth process (the forecaster never sees these parameters).
const DOW_MULT = [0.86, 1.0, 0.95, 0.97, 1.05, 1.24, 1.1]; // Sun..Sat
function intraday(w, h) {
  const shift = w === 0 || w === 6 ? 1.5 : 0;
  const morning = 0.9 * Math.exp(-0.5 * ((h - 8 - shift) / 1.8) ** 2);
  const evening = 1.35 * Math.exp(-0.5 * ((h - 19 - shift / 2) / 2.6) ** 2);
  const night = h < 5 ? 0.25 : 0.45;
  return night + morning + evening;
}
const SHARES = [0, 1, 2, 3, 4, 5, 6].map((w) => {
  const a = Array.from({ length: 24 }, (_, h) => intraday(w, h));
  const s = a.reduce((x, y) => x + y, 0);
  return a.map((x) => x / s);
});

const days = Math.ceil(asOfHour / 24) + 1;
const stepDay = cal.dayOf('2026-08-17'); // a new sub-client goes live: +12% volume
let shock = 0;
const hourly = [];
const truthDaily = [];
for (let d = 0; d < days; d++) {
  const f = cal.flags(d);
  shock = 0.55 * shock + 0.075 * randn();
  let level = 1.16e6 * Math.exp(0.00105 * d) * (d >= stepDay ? 1.12 : 1);
  let m = DOW_MULT[f.dow];
  if (f.payday) m *= 1.42;
  if (f.afterPayday) m *= 1.12;
  if (f.monthStart) m *= 1.16;
  if (f.preHoliday) m *= 1.12;
  if (f.holiday) m *= cal.isMajorHoliday(d) ? 0.8 : 1.02;
  const dayTotal = level * m * Math.exp(shock);
  truthDaily.push(dayTotal);
  for (let h = 0; h < 24; h++) {
    const t = d * 24 + h;
    if (t >= asOfHour) break;
    let v = dayTotal * SHARES[f.dow][h] * Math.exp(0.11 * randn() - 0.006);
    // Occasional bulk payout files (claims batches, marketplace settlements) in business hours.
    if (h >= 7 && h <= 16 && rnd() < 0.03 / 10) v += Math.exp(Math.log(260000) + 0.55 * randn());
    hourly.push(Math.round(v * 100) / 100);
  }
}

const out = { meta: { ...meta, asOfHour, hours: hourly.length }, hourly };
writeFileSync(new URL('../data/flows.json', import.meta.url), JSON.stringify(out));
const tot = hourly.reduce((a, b) => a + b, 0);
console.log(`hours=${hourly.length} days=${(hourly.length / 24).toFixed(1)} total=$${(tot / 1e9).toFixed(3)}B lastWeekDaily=$${(hourly.slice(-24 * 7).reduce((a, b) => a + b, 0) / 7 / 1e6).toFixed(2)}M`);
