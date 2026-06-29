#!/usr/bin/env node
/* TDD tests for the public sign-up pure logic (public/monthly-draw.js).
 * validateSignup: gate a prospective player's name/phone/days against the
 * enabled game days. unhandledCount: badge count for the admin Sign-ups tab.
 * timeAgo: human "x ago" label (now injected — never reads the clock). */
'use strict';
const {
  validateSignup, unhandledCount, timeAgo,
  validateJoinRequest, addMonthsISO, isValidISO, isoWeekday, weekdayName, SKILLS,
} = require('../public/monthly-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const ENABLED = ['Friday', 'Sunday', 'Monday'];

// ── validateSignup({name,phone,days}, enabledDays) -> {ok,error} ──
{
  const r = validateSignup({ name: '', phone: '0123', days: ['Friday'] }, ENABLED);
  check('missing name -> not ok', r.ok === false);
  check('missing name -> has error message', typeof r.error === 'string' && r.error.length > 0);
}
{
  const r = validateSignup({ name: '   ', phone: '0123', days: ['Friday'] }, ENABLED);
  check('whitespace-only name -> not ok', r.ok === false);
}
{
  const longName = 'a'.repeat(81);
  const r = validateSignup({ name: longName, phone: '0123', days: ['Friday'] }, ENABLED);
  check('name over 80 chars -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '', days: ['Friday'] }, ENABLED);
  check('missing phone -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: 'call me', days: ['Friday'] }, ENABLED);
  check('phone without any digit -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '0123', days: [] }, ENABLED);
  check('empty days -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '0123', days: 'Friday' }, ENABLED);
  check('days not an array -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '0123', days: ['Tuesday'] }, ENABLED);
  check('day not in enabled set -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '0123', days: ['Friday', 'Wednesday'] }, ENABLED);
  check('one valid + one invalid day -> not ok', r.ok === false);
}
{
  const r = validateSignup({ name: 'Alex', phone: '012-345 6789', days: ['Friday', 'Monday'] }, ENABLED);
  check('valid signup -> ok', r.ok === true);
  check('valid signup -> empty error', r.error === '');
}
{
  const r = validateSignup({ name: '  Alex  ', phone: '0123', days: ['Sunday'] }, ENABLED);
  check('name with surrounding spaces still ok', r.ok === true);
}
// Day-name round-trip: the submit endpoint slices each day to 20 chars before
// validating. Enabled day names are weekday words (<= 9 chars) so the slice
// must never truncate a valid day into an invalid one.
{
  let allSurvive = true;
  ENABLED.forEach((d) => { if (d.slice(0, 20) !== d) allSurvive = false; });
  check('enabled day names survive 20-char slice intact', allSurvive === true);
  const sliced = ENABLED.map((d) => d.slice(0, 20));
  const r = validateSignup({ name: 'Alex', phone: '0123', days: sliced }, ENABLED);
  check('sliced day names still validate as ok', r.ok === true);
}

// ── unhandledCount(signups) -> number of !handled entries ──
check('unhandledCount: empty array -> 0', unhandledCount([]) === 0);
check('unhandledCount: non-array -> 0', unhandledCount(null) === 0);
check('unhandledCount: undefined -> 0', unhandledCount(undefined) === 0);
check('unhandledCount: all unhandled -> count',
  unhandledCount([{ handled: false }, {}, { handled: undefined }]) === 3);
check('unhandledCount: all handled -> 0',
  unhandledCount([{ handled: true }, { handled: true }]) === 0);
check('unhandledCount: mixed -> only unhandled',
  unhandledCount([{ handled: true }, { handled: false }, {}, { handled: true }]) === 2);

// ── timeAgo(at, now) -> human label; now injected (no clock read) ──
const NOW = 1_700_000_000_000;
const sec = 1000, min = 60 * sec, hr = 60 * min, day = 24 * hr;
check('timeAgo: 0 diff -> just now', timeAgo(NOW, NOW) === 'just now');
check('timeAgo: 30s -> just now', timeAgo(NOW - 30 * sec, NOW) === 'just now');
check('timeAgo: 44s -> just now', timeAgo(NOW - 44 * sec, NOW) === 'just now');
check('timeAgo: 45s -> 1m ago', timeAgo(NOW - 45 * sec, NOW) === '1m ago');
check('timeAgo: 5m -> 5m ago', timeAgo(NOW - 5 * min, NOW) === '5m ago');
check('timeAgo: 59m -> 59m ago', timeAgo(NOW - 59 * min, NOW) === '59m ago');
check('timeAgo: 60m -> 1h ago', timeAgo(NOW - 60 * min, NOW) === '1h ago');
check('timeAgo: 2h -> 2h ago', timeAgo(NOW - 2 * hr, NOW) === '2h ago');
check('timeAgo: 23h -> 23h ago', timeAgo(NOW - 23 * hr, NOW) === '23h ago');
check('timeAgo: 24h -> 1d ago', timeAgo(NOW - 24 * hr, NOW) === '1d ago');
check('timeAgo: 3d -> 3d ago', timeAgo(NOW - 3 * day, NOW) === '3d ago');
check('timeAgo: non-finite at -> empty string', timeAgo('nope', NOW) === '');

// ════════════════════════════════════════════════════════════════════
// NEW (2026-06-29): calendar/skill join flow — dates + skill validation
// ════════════════════════════════════════════════════════════════════

// ── isValidISO(s): only a real YYYY-MM-DD that round-trips ──
check('isValidISO: real date -> true', isValidISO('2026-06-29') === true);
check('isValidISO: feb 30 -> false', isValidISO('2026-02-30') === false);
check('isValidISO: month 13 -> false', isValidISO('2026-13-01') === false);
check('isValidISO: day 00 -> false', isValidISO('2026-06-00') === false);
check('isValidISO: garbage -> false', isValidISO('nope') === false);
check('isValidISO: non-string -> false', isValidISO(20260629) === false);
check('isValidISO: empty -> false', isValidISO('') === false);
check('isValidISO: leap day valid -> true', isValidISO('2028-02-29') === true);
check('isValidISO: non-leap feb29 -> false', isValidISO('2026-02-29') === false);

// ── isoWeekday(iso) / weekdayName(iso): 0=Sun..6=Sat ──
check('isoWeekday: 2026-06-29 -> Monday(1)', isoWeekday('2026-06-29') === 1);
check('isoWeekday: 2026-06-28 -> Sunday(0)', isoWeekday('2026-06-28') === 0);
check('isoWeekday: 2026-06-26 -> Friday(5)', isoWeekday('2026-06-26') === 5);
check('weekdayName: 2026-06-29 -> Monday', weekdayName('2026-06-29') === 'Monday');
check('weekdayName: 2026-06-28 -> Sunday', weekdayName('2026-06-28') === 'Sunday');

// ── addMonthsISO(iso, n): deterministic, month-end clamped ──
check('addMonthsISO: simple +3', addMonthsISO('2026-06-29', 3) === '2026-09-29');
check('addMonthsISO: month-end clamp (Nov30 +3 -> Feb28)', addMonthsISO('2026-11-30', 3) === '2027-02-28');
check('addMonthsISO: clamp to leap Feb29 (Nov30 +3 in 2027 -> 2028-02-29)', addMonthsISO('2027-11-30', 3) === '2028-02-29');
check('addMonthsISO: Dec rollover (+1)', addMonthsISO('2026-12-15', 1) === '2027-01-15');
check('addMonthsISO: Jan31 +1 -> Feb28', addMonthsISO('2026-01-31', 1) === '2026-02-28');
check('addMonthsISO: zero months -> same', addMonthsISO('2026-06-29', 0) === '2026-06-29');

// ── SKILLS allow-list ──
check('SKILLS is the three levels', Array.isArray(SKILLS) &&
  SKILLS.length === 3 && SKILLS.indexOf('Beginner') !== -1 &&
  SKILLS.indexOf('Intermediate') !== -1 && SKILLS.indexOf('Advanced') !== -1);

// ── validateJoinRequest(input, {enabledWeekdays, todayISO, maxISO}) ──
const WD = [0, 1, 5];                 // Sun, Mon, Fri (matches default socialGames)
const TODAY = '2026-06-29';           // a Monday
const MAX = addMonthsISO(TODAY, 3);   // 2026-09-29
const OPTS = { enabledWeekdays: WD, todayISO: TODAY, maxISO: MAX };
const okInput = { name: 'Alex', phone: '0123', skill: 'Intermediate', dates: ['2026-06-29'] };
{
  const r = validateJoinRequest(okInput, OPTS);
  check('join: valid -> ok', r.ok === true);
  check('join: valid -> empty error', r.error === '');
  check('join: valid -> clean.days derived', r.clean && Array.isArray(r.clean.days) && r.clean.days[0] === 'Monday');
  check('join: valid -> clean.dates kept', r.clean && r.clean.dates.length === 1 && r.clean.dates[0] === '2026-06-29');
  check('join: valid -> clean.skill kept', r.clean && r.clean.skill === 'Intermediate');
}
check('join: empty name -> not ok', validateJoinRequest({ ...okInput, name: '' }, OPTS).ok === false);
check('join: name>80 -> not ok', validateJoinRequest({ ...okInput, name: 'a'.repeat(81) }, OPTS).ok === false);
check('join: no-digit phone -> not ok', validateJoinRequest({ ...okInput, phone: 'call me' }, OPTS).ok === false);
check('join: missing skill -> not ok', validateJoinRequest({ ...okInput, skill: '' }, OPTS).ok === false);
check('join: skill not in allow-list -> not ok', validateJoinRequest({ ...okInput, skill: 'Pro' }, OPTS).ok === false);
check('join: empty dates -> not ok', validateJoinRequest({ ...okInput, dates: [] }, OPTS).ok === false);
check('join: dates not array -> not ok', validateJoinRequest({ ...okInput, dates: '2026-06-29' }, OPTS).ok === false);
check('join: past date -> not ok', validateJoinRequest({ ...okInput, dates: ['2026-06-22'] }, OPTS).ok === false);
check('join: date > maxISO -> not ok', validateJoinRequest({ ...okInput, dates: ['2026-10-05'] }, OPTS).ok === false);
check('join: wrong weekday (Wed) -> not ok', validateJoinRequest({ ...okInput, dates: ['2026-07-01'] }, OPTS).ok === false);
check('join: invalid ISO date -> not ok', validateJoinRequest({ ...okInput, dates: ['2026-02-30'] }, OPTS).ok === false);
check('join: one valid + one invalid date -> not ok',
  validateJoinRequest({ ...okInput, dates: ['2026-06-29', '2026-07-01'] }, OPTS).ok === false);
// inclusive +max boundary: a date exactly == maxISO, when its weekday is enabled, is accepted
{
  const bMax = addMonthsISO('2026-06-26', 3);          // 2026-09-26
  const bOpts = { enabledWeekdays: [isoWeekday(bMax)], todayISO: '2026-06-26', maxISO: bMax };
  const r = validateJoinRequest({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: [bMax] }, bOpts);
  check('join: date == maxISO (inclusive) -> ok', r.ok === true);
}
// de-dupe: duplicate dates collapse to one
{
  const r = validateJoinRequest({ ...okInput, dates: ['2026-06-29', '2026-06-29'] }, OPTS);
  check('join: duplicate dates de-duped', r.ok === true && r.clean.dates.length === 1);
}
// cap: more than 12 distinct valid dates are capped to 12
{
  const mondays = [];
  const d = new Date(2026, 5, 29);                      // Jun 29 2026 (Mon)
  for (let i = 0; i < 14; i++) {
    mondays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 7);
  }
  const capOpts = { enabledWeekdays: [1], todayISO: '2026-06-29', maxISO: addMonthsISO('2026-06-29', 4) };
  const r = validateJoinRequest({ name: 'Alex', phone: '0123', skill: 'Advanced', dates: mondays }, capOpts);
  check('join: >12 dates capped to 12', r.ok === true && r.clean.dates.length === 12);
}
// non-object input is tolerated (no throw)
check('join: null input -> not ok (no throw)', validateJoinRequest(null, OPTS).ok === false);

// ════════════════════════════════════════════════════════════════════
// Server submit decision — api/state.js buildSignup(body, ctx)
// Mirrors the lib but returns {ok, error?, fields?} (handler stamps id/at).
// ════════════════════════════════════════════════════════════════════
const { buildSignup } = require('../api/state.js');
const SG = [
  { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
  { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
  { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
];
const SCTX = { socialGames: SG, todayISO: '2026-06-29' };
{
  const r = buildSignup({ name: 'Alex', phone: '0123', skill: 'Intermediate', dates: ['2026-06-29'] }, SCTX);
  check('server: valid dates+skill -> ok', r.ok === true);
  check('server: derives days from dates', r.fields && r.fields.days[0] === 'Monday');
  check('server: keeps skill+dates', r.fields && r.fields.skill === 'Intermediate' && r.fields.dates[0] === '2026-06-29');
  check('server: fields has no id/at (handler stamps)', r.fields && r.fields.id === undefined && r.fields.at === undefined);
}
check('server: bad skill -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: 'Pro', dates: ['2026-06-29'] }, SCTX).ok === false);
check('server: missing skill -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: '', dates: ['2026-06-29'] }, SCTX).ok === false);
check('server: past date -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-06-22'] }, SCTX).ok === false);
check('server: wrong weekday -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-07-01'] }, SCTX).ok === false);
check('server: invalid ISO -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-02-30'] }, SCTX).ok === false);
check('server: empty dates -> not ok', buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: [] }, SCTX).ok === false);
check('server: missing phone -> not ok', buildSignup({ name: 'Alex', phone: '', skill: 'Beginner', dates: ['2026-06-29'] }, SCTX).ok === false);
check('server: missing name -> not ok', buildSignup({ name: '', phone: '0123', skill: 'Beginner', dates: ['2026-06-29'] }, SCTX).ok === false);
// game day missing a numeric weekday still resolves via day name (no -1 poisoning)
{
  const sg2 = [{ id: 'x', day: 'Monday', time: '9–11pm', enabled: true }]; // no weekday field
  const r = buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-06-29'] }, { socialGames: sg2, todayISO: '2026-06-29' });
  check('server: game day w/o numeric weekday resolves by name', r.ok === true);
  const r2 = buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-06-26'] }, { socialGames: sg2, todayISO: '2026-06-29' });
  check('server: Friday rejected when only Monday enabled', r2.ok === false);
}
// dedupe + cap 12
{
  const mondays = [];
  const d = new Date(2026, 5, 29);
  for (let i = 0; i < 14; i++) { mondays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); d.setDate(d.getDate() + 7); }
  const r = buildSignup({ name: 'Alex', phone: '0123', skill: 'Advanced', dates: mondays.slice(0, 11) }, SCTX);
  check('server: <=12 valid dates kept', r.ok === true && r.fields.dates.length === 11);
  // All 14 mondays (Jun 29 .. Sep 28) fall inside the default 3-month window, so
  // the server must cap an over-long submission to exactly 12 — never more.
  const rcap = buildSignup({ name: 'Alex', phone: '0123', skill: 'Advanced', dates: mondays }, SCTX);
  check('server: >12 dates capped to 12', rcap.ok === true && rcap.fields.dates.length === 12);
  const rdup = buildSignup({ name: 'Alex', phone: '0123', skill: 'Advanced', dates: ['2026-06-29', '2026-06-29'] }, SCTX);
  check('server: duplicate dates de-duped', rdup.ok === true && rdup.fields.dates.length === 1);
}
// legacy days-only path still works against day NAMES
{
  const r = buildSignup({ name: 'Alex', phone: '0123', days: ['Friday', 'Monday'] }, SCTX);
  check('server: legacy days path -> ok (no skill/dates)', r.ok === true && r.fields.skill === undefined && r.fields.dates === undefined && r.fields.days.length === 2);
}
check('server: legacy bad day -> not ok', buildSignup({ name: 'Alex', phone: '0123', days: ['Tuesday'] }, SCTX).ok === false);
// injection: only sanitized fields returned, never arbitrary body keys
{
  const r = buildSignup({ name: 'Alex', phone: '0123', skill: 'Beginner', dates: ['2026-06-29'], roster: [1, 2, 3], siteCode: null }, SCTX);
  check('server: extra body fields are ignored', r.ok === true && r.fields.roster === undefined && r.fields.siteCode === undefined);
}
// null body tolerated (no throw)
check('server: null body -> not ok (no throw)', buildSignup(null, SCTX).ok === false);

console.log(`\nsign-up tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
