#!/usr/bin/env node
/* Tests for api/state.js regularsToAdd — the pure helper behind the admin's
 * one-tap "Add regulars" prompt. Given the weekly-regulars map (weekday -> ids),
 * a weekday, the ids already in today's session, and the current roster ids, it
 * returns the regulars that should be offered: on the roster, not already
 * playing, de-duped, order-preserving. The frontend keeps an identical mirror. */
'use strict';
const { regularsToAdd, seedRegularPlayers, applySessionDateChange } = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROSTER = ['p0', 'p1', 'p2', 'p5', 'p6'];

// ── Basic: Monday regulars, none in session yet ──
{
  const reg = { 1: ['p0', 'p5', 'p6'], 5: ['p1'] };
  check('monday regulars returned in order', eq(regularsToAdd(reg, 1, [], ROSTER), ['p0', 'p5', 'p6']));
  check('friday regulars returned', eq(regularsToAdd(reg, 5, [], ROSTER), ['p1']));
  check('day with no regulars -> []', eq(regularsToAdd(reg, 3, [], ROSTER), []));
}

// ── String weekday keys behave like number keys (object coercion) ──
{
  const reg = { '1': ['p0', 'p5'] };
  check('number weekday hits string key', eq(regularsToAdd(reg, 1, [], ROSTER), ['p0', 'p5']));
  check('string weekday hits string key', eq(regularsToAdd(reg, '1', [], ROSTER), ['p0', 'p5']));
}

// ── Already-in-session players are excluded ──
{
  const reg = { 1: ['p0', 'p5', 'p6'] };
  check('excludes players already ticked in', eq(regularsToAdd(reg, 1, ['p5'], ROSTER), ['p0', 'p6']));
  check('all already in -> []', eq(regularsToAdd(reg, 1, ['p0', 'p5', 'p6'], ROSTER), []));
}

// ── Deleted players (no longer on the roster) never resurface ──
{
  const reg = { 1: ['p0', 'p9', 'p5'] }; // p9 was deleted from the roster
  check('drops ids not on the roster', eq(regularsToAdd(reg, 1, [], ROSTER), ['p0', 'p5']));
}

// ── Duplicates within a day are collapsed ──
{
  const reg = { 1: ['p0', 'p0', 'p5'] };
  check('de-dupes repeated ids', eq(regularsToAdd(reg, 1, [], ROSTER), ['p0', 'p5']));
}

// ── Tolerant of missing / malformed inputs (never throws, returns []) ──
{
  check('null regulars -> []', eq(regularsToAdd(null, 1, [], ROSTER), []));
  check('array regulars -> []', eq(regularsToAdd(['p0'], 1, [], ROSTER), []));
  check('non-array day value -> []', eq(regularsToAdd({ 1: 'p0' }, 1, [], ROSTER), []));
  check('missing sessionIds/rosterIds -> [] (nothing on roster)', eq(regularsToAdd({ 1: ['p0'] }, 1), []));
  check('empty roster -> []', eq(regularsToAdd({ 1: ['p0'] }, 1, [], []), []));
}

// ── Does not mutate its inputs ──
{
  const reg = { 1: ['p0', 'p5'] };
  const session = ['p5'];
  regularsToAdd(reg, 1, session, ROSTER);
  check('regulars map untouched', eq(reg, { 1: ['p0', 'p5'] }));
  check('sessionIds untouched', eq(session, ['p5']));
}

// ── seedRegularPlayers: {id,name} for the weekday a date falls on ──
{
  // 2026-07-20 is a Monday (getDay()===1); 2026-07-16 is a Thursday (4)
  const state = {
    roster: [{ id: 'p0', name: 'Harvey' }, { id: 'p5', name: 'Alex' }, { id: 'p6', name: 'Kokyan' }],
    regulars: { 1: ['p0', 'p6'], 4: ['p5'] },
  };
  check('seeds Monday regulars as {id,name}', eq(seedRegularPlayers(state, '2026-07-20'), [{ id: 'p0', name: 'Harvey' }, { id: 'p6', name: 'Kokyan' }]));
  check('seeds Thursday regulars', eq(seedRegularPlayers(state, '2026-07-16'), [{ id: 'p5', name: 'Alex' }]));
  check('no regulars for the weekday -> []', eq(seedRegularPlayers(state, '2026-07-21'), [])); // Tuesday
  check('skips ids no longer on the roster', eq(seedRegularPlayers({ roster: [{ id: 'p0', name: 'Harvey' }], regulars: { 1: ['p0', 'gone'] } }, '2026-07-20'), [{ id: 'p0', name: 'Harvey' }]));
  check('tolerates missing regulars -> []', eq(seedRegularPlayers({ roster: [{ id: 'p0', name: 'Harvey' }] }, '2026-07-20'), []));
}

// ── applySessionDateChange auto-adds regulars on a FRESH day ──
{
  const base = {
    sessionDate: '2026-07-18', // a Saturday, no regulars set for it
    players: [{ id: 'p9', name: 'Guest' }],
    roster: [{ id: 'p0', name: 'Harvey' }, { id: 'p5', name: 'Alex' }],
    regulars: { 1: ['p0'] }, // Harvey is a Monday regular
    numCourts: 2, courtNumbers: [1, 2], sessions: {},
  };
  const r = applySessionDateChange(base, '2026-07-20', '2026-07-18'); // -> Monday
  check('transition ok', r.ok === true);
  check('fresh Monday auto-adds Harvey', eq(r.state.players, [{ id: 'p0', name: 'Harvey' }]));
  check('does not mutate the input players', eq(base.players, [{ id: 'p9', name: 'Guest' }]));

  // A weekday with no regulars starts empty (backward-compatible behaviour)
  const r2 = applySessionDateChange(base, '2026-07-21', '2026-07-18'); // Tuesday, no regulars
  check('fresh day without regulars stays empty', eq(r2.state.players, []));

  // No regulars map at all -> empty (unchanged legacy behaviour)
  const r3 = applySessionDateChange({ sessionDate: '2026-07-18', players: [{ id: 'p9', name: 'G' }], roster: [{ id: 'p0', name: 'Harvey' }], sessions: {} }, '2026-07-20', '2026-07-18');
  check('no regulars map -> fresh day empty', eq(r3.state.players, []));
}

// ── Restoring a SAVED day keeps its players (regulars are NOT re-added) ──
{
  const base = {
    sessionDate: '2026-07-18',
    players: [],
    roster: [{ id: 'p0', name: 'Harvey' }, { id: 'p5', name: 'Alex' }],
    regulars: { 1: ['p0'] },
    sessions: { '2026-07-20': { players: [{ id: 'p5', name: 'Alex' }], rounds: [], numCourts: 2, courtNumbers: [1, 2], courtRounds: [] } },
  };
  const r = applySessionDateChange(base, '2026-07-20', '2026-07-18');
  check('restored saved Monday keeps its own players, not regulars', eq(r.state.players, [{ id: 'p5', name: 'Alex' }]));
}

console.log(`\nregulars tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
