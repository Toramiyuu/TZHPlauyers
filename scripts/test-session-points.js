#!/usr/bin/env node
/*
 * test-session-points.js — behavioural guard for the "award +2 points per
 * session played" rule (feature added 2026-07-08).
 *
 * Decision (with the user): each player who appears in a session earns +2
 * points ONCE, the moment that day is closed (its date changes away / the
 * midnight rollover advances it). Points feed the existing all-time
 * leaderboard (state.roster[].points). The award must be:
 *
 *   - once per session DATE (revisiting + re-closing a day never re-awards),
 *   - applied only to roster players actually in that day's `players`,
 *   - a no-op for guests (present in players, absent from roster),
 *   - a no-op for an empty day (nobody played),
 *   - pure (never mutates the passed state).
 *
 * The award lives inside applySessionDateChange(state, newDate, today) — the
 * same pure helper that snapshots the outgoing day — so BOTH an admin date
 * change and the automatic midnight rollover trigger it. Idempotency is tracked
 * by state.awardedSessions (array of already-awarded date strings) which
 * survives snapshot/restore, unlike a per-snapshot flag.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const mod = require(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'));
const applySessionDateChange = mod.applySessionDateChange;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const ptsOf = (state, id) => (state.roster.find(r => r.id === id) || {}).points;

function baseState(overrides) {
  return Object.assign({
    sessionDate: '2026-07-01',
    players: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }],
    roster: [
      { id: 'p0', name: 'Thomas', points: 10 },
      { id: 'p1', name: 'Desmond', points: 0 },
      { id: 'p2', name: 'Celine', points: 5 },
    ],
    rounds: [{ label: 'Round 1', courts: [{ team1: ['p0', 'p1'], team2: [] }] }],
    numCourts: 2,
    courtNumbers: [1, 2],
    courtRounds: [0, 0],
    currentRound: 1,
    endingSoon: [],
    sessions: {},
  }, overrides || {});
}

if (typeof applySessionDateChange !== 'function') {
  failures.push('applySessionDateChange is not exported from api/state.js');
} else {
  const TODAY = '2026-07-01';

  // 1. Closing a day with players → each participating roster player +2.
  {
    const r = applySessionDateChange(baseState(), '2026-07-02', TODAY);
    check('award: player p0 gets +2 (10 → 12)', ptsOf(r.state, 'p0') === 12);
    check('award: player p1 gets +2 (0 → 2)', ptsOf(r.state, 'p1') === 2);
    check('award: non-participant p2 unchanged (5)', ptsOf(r.state, 'p2') === 5);
    check('award: outgoing date recorded in awardedSessions',
      Array.isArray(r.state.awardedSessions) && r.state.awardedSessions.includes('2026-07-01'));
  }

  // 2. Idempotency: leave a day, come back to it, leave again → still only +2.
  {
    const away = applySessionDateChange(baseState(), '2026-06-30', TODAY); // closes 07-01, awards +2
    const back = applySessionDateChange(away.state, '2026-07-01', TODAY);  // restore 07-01 as live
    const again = applySessionDateChange(back.state, '2026-07-02', TODAY); // close 07-01 AGAIN
    check('idempotent: p0 still 12 after re-closing same date', ptsOf(again.state, 'p0') === 12);
    check('idempotent: p1 still 2 after re-closing same date', ptsOf(again.state, 'p1') === 2);
    check('idempotent: awardedSessions lists 07-01 exactly once',
      (again.state.awardedSessions || []).filter(d => d === '2026-07-01').length === 1);
  }

  // 3. Empty day (nobody played) → no award, date not recorded.
  {
    const r = applySessionDateChange(baseState({ players: [] }), '2026-07-02', TODAY);
    check('empty: p0 unchanged (10)', ptsOf(r.state, 'p0') === 10);
    check('empty: 07-01 NOT in awardedSessions',
      !((r.state.awardedSessions || []).includes('2026-07-01')));
  }

  // 4. Guests (in players, not in roster) don't crash and earn nothing.
  {
    const st = baseState({ players: [{ id: 'p0', name: 'Thomas' }, { id: 'g1', name: 'Walk-in', guest: true }] });
    const r = applySessionDateChange(st, '2026-07-02', TODAY);
    check('guest: p0 still awarded +2 (12)', ptsOf(r.state, 'p0') === 12);
    check('guest: roster length unchanged (no phantom guest added)', r.state.roster.length === 3);
  }

  // 5. Purity: the input roster/points are never mutated.
  {
    const input = baseState();
    applySessionDateChange(input, '2026-07-02', TODAY);
    check('purity: input p0 points still 10', input.roster.find(r => r.id === 'p0').points === 10);
    check('purity: input has no awardedSessions leaked', input.awardedSessions === undefined);
  }

  // 6. No-op when target date equals current date → no award.
  {
    const r = applySessionDateChange(baseState(), '2026-07-01', TODAY);
    check('no-op: p0 unchanged (10)', ptsOf(r.state, 'p0') === 10);
    check('no-op: nothing awarded', !((r.state.awardedSessions || []).length));
  }
}

console.log('test-session-points — +2 points per session played\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  each participant earns +2 on session close');
  console.log('  PASS  award is once-per-date (idempotent across revisit)');
  console.log('  PASS  empty day / guests / purity / no-op all correct');
  console.log('\nRESULT: PASS — all session-points assertions green.');
  process.exit(0);
}
