#!/usr/bin/env node
/* TDD tests for the public sign-up pure logic (public/monthly-draw.js).
 * validateSignup: gate a prospective player's name/phone/days against the
 * enabled game days. unhandledCount: badge count for the admin Sign-ups tab.
 * timeAgo: human "x ago" label (now injected — never reads the clock). */
'use strict';
const { validateSignup, unhandledCount, timeAgo } = require('../public/monthly-draw.js');

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

console.log(`\nsign-up tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
