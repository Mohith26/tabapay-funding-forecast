// Calendar helpers. All times are Pacific wall-clock hours (the portal's settlement
// docs quote cutoffs in PT), indexed as hours since 00:00 PT on the series start date.

const MS_DAY = 86400000;

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function makeCalendar(meta) {
  const start = parseDate(meta.start);
  const holidays = new Set(meta.fedHolidays);
  const majorHolidays = new Set(meta.majorHolidays || []);
  const anchor = parseDate(meta.paydayAnchor);

  const dateOf = (day) => fmtDate(start + day * MS_DAY);
  const dayOf = (s) => Math.round((parseDate(s) - start) / MS_DAY);
  const dow = (day) => new Date(start + day * MS_DAY).getUTCDay(); // 0 Sun .. 6 Sat
  const dom = (day) => new Date(start + day * MS_DAY).getUTCDate();
  const isHoliday = (day) => holidays.has(dateOf(day));
  const isBusinessDay = (day) => {
    const w = dow(day);
    return w !== 0 && w !== 6 && !isHoliday(day);
  };
  const isPayday = (day) => {
    const diff = Math.round((start + day * MS_DAY - anchor) / MS_DAY);
    return diff >= 0 && diff % 14 === 0;
  };
  const nextBusinessDay = (day) => {
    let d = day + 1;
    while (!isBusinessDay(d)) d++;
    return d;
  };
  // Flags the forecaster is allowed to know in advance (all are calendar facts).
  const flags = (day) => {
    const w = dow(day);
    return {
      dow: w,
      payday: isPayday(day) ? 1 : 0,
      afterPayday: isPayday(day - 1) ? 1 : 0,
      monthStart: dom(day) <= 2 ? 1 : 0,
      holiday: isHoliday(day) ? 1 : 0,
      preHoliday: !isHoliday(day) && isHoliday(day + 1) && w !== 0 && w !== 6 ? 1 : 0,
    };
  };
  return {
    start, dateOf, dayOf, dow, dom, isHoliday, isBusinessDay, isPayday, nextBusinessDay, flags,
    isMajorHoliday: (day) => majorHolidays.has(dateOf(day)),
  };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function labelDay(cal, day) {
  const [y, m, d] = cal.dateOf(day).split('-').map(Number);
  return { dow: DOW[cal.dow(day)], mdy: `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`, short: `${MON[m - 1]} ${d}`, md: `${m}/${d}` };
}
