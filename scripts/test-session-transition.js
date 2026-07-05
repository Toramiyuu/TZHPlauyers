#!/usr/bin/env node
/*
 * test-session-transition.js — behavioural guard for the session-date change
 * logic shared by api/state.js (production) and server.js (local dev).
 *
 * Bugs this locks down (reported 2026-07-01, "the luckydraw ... go to a next
 * day it would not show me the next day. Data disappeared."):
 *
 *   A) The server rejected ANY future session date (> today), while the admin
 *      UI offers dates up to a month ahead — so "go to the next day" 400'd and
 *      the date silently reverted. Fix: allow up to one month ahead (matches
 *      public/index.html maxSessionDateISO).
 *
 *   B) Switching the session date away and back to a day that HAD a saved
 *      session returned an EMPTY day — the snapshot in state.sessions[date] was
 *      never restored. Fix: restore the saved session on switch.
 *
 * applySessionDateChange(state, newDate, today) is a PURE function exported from
 * api/state.js. It returns { ok:true, state } or { ok:false, error }.
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const mod = require(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'));
const applySessionDateChange = mod.applySessionDateChange;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

function baseState(overrides) {
  return Object.assign({
    sessionDate: '2026-07-01',
    players: [{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }],
    rounds: [{ label: 'Round 1', courts: [{ team1: ['p0', 'p1'], team2: [] }] }],
    numCourts: 3,
    courtNumbers: [5, 6, 7],
    courtRounds: [0, 0, 0],
    currentRound: 1,
    endingSoon: ['p0'],
    sessions: {},
  }, overrides || {});
}

if (typeof applySessionDateChange !== 'function') {
  failures.push('applySessionDateChange is not exported from api/state.js');
} else {
  const TODAY = '2026-07-01';

  // 1. Future date within a month is ACCEPTED (Bug A fix).
  {
    const r = applySessionDateChange(baseState(), '2026-07-15', TODAY);
    check('A: future date within a month → ok', r.ok === true);
    check('A: sessionDate advances to the future day', r.state.sessionDate === '2026-07-15');
  }

  // 2. Exactly one month ahead is accepted; beyond a month is rejected.
  {
    const ok = applySessionDateChange(baseState(), '2026-08-01', TODAY);
    check('A: exactly one month ahead → ok', ok.ok === true);
    const bad = applySessionDateChange(baseState(), '2026-08-02', TODAY);
    check('A: more than a month ahead → rejected', bad.ok === false && !!bad.error);
    check('A: rejection leaves no state', bad.state === undefined);
  }

  // 3. Leaving a day snapshots it; a fresh (unsaved) target day starts empty
  //    but KEEPS numCourts + courtNumbers (venue keeps the same courts).
  {
    const r = applySessionDateChange(baseState(), '2026-07-03', TODAY);
    check('fresh day: players reset to empty', Array.isArray(r.state.players) && r.state.players.length === 0);
    check('fresh day: rounds reset to empty', Array.isArray(r.state.rounds) && r.state.rounds.length === 0);
    check('fresh day: currentRound reset', r.state.currentRound === 0);
    check('fresh day: endingSoon reset', Array.isArray(r.state.endingSoon) && r.state.endingSoon.length === 0);
    check('fresh day: numCourts carried over', r.state.numCourts === 3);
    check('fresh day: courtNumbers carried over', JSON.stringify(r.state.courtNumbers) === JSON.stringify([5, 6, 7]));
    check('leaving day snapshotted into sessions', !!(r.state.sessions && r.state.sessions['2026-07-01']));
    check('snapshot keeps the leaving day players',
      JSON.stringify((r.state.sessions['2026-07-01'] || {}).players) ===
      JSON.stringify([{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }]));
  }

  // 4. Switch away then BACK to a day with a saved session → RESTORED (Bug B fix).
  {
    const away = applySessionDateChange(baseState(), '2026-06-30', TODAY); // snapshots 07-01
    check('B: setup switched away ok', away.ok === true);
    const back = applySessionDateChange(away.state, '2026-07-01', TODAY);  // back to saved day
    check('B: restore ok', back.ok === true);
    check('B: players RESTORED (not empty)',
      JSON.stringify(back.state.players) === JSON.stringify([{ id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' }]));
    check('B: rounds RESTORED', Array.isArray(back.state.rounds) && back.state.rounds.length === 1);
    check('B: numCourts RESTORED', back.state.numCourts === 3);
    check('B: courtNumbers RESTORED', JSON.stringify(back.state.courtNumbers) === JSON.stringify([5, 6, 7]));
    // The restored day is now the LIVE day, so it must not linger in the
    // sessions map (else the history calendar shows the active day as history).
    check('B: restored day removed from sessions map', !(back.state.sessions || {})['2026-07-01']);
  }

  // 5. No-op when the target date equals the current date (no snapshot, no wipe).
  {
    const r = applySessionDateChange(baseState(), '2026-07-01', TODAY);
    check('no-op: ok', r.ok === true);
    check('no-op: players untouched', r.state.players.length === 2);
    check('no-op: nothing snapshotted', Object.keys(r.state.sessions || {}).length === 0);
  }

  // 6. Purity: the input state is not mutated.
  {
    const input = baseState();
    applySessionDateChange(input, '2026-07-09', TODAY);
    check('purity: input players untouched', input.players.length === 2);
    check('purity: input sessionDate untouched', input.sessionDate === '2026-07-01');
    check('purity: input sessions untouched', Object.keys(input.sessions).length === 0);
  }

  // 7. Pruning: sessions older than 31 days are dropped on switch.
  {
    const st = baseState({ sessions: { '2026-05-01': { players: [] } } }); // ~61 days before today
    const r = applySessionDateChange(st, '2026-07-05', TODAY);
    check('prune: stale session dropped', !(r.state.sessions || {})['2026-05-01']);
    check('prune: current leaving day kept', !!(r.state.sessions || {})['2026-07-01']);
  }
}

console.log('test-session-transition — session-date change (allow future + restore)\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  future dates up to a month ahead accepted (Bug A)');
  console.log('  PASS  saved session restored on switch-back (Bug B)');
  console.log('  PASS  fresh day resets but keeps courts; purity + pruning intact');
  console.log('\nRESULT: PASS — all session-transition assertions green.');
  process.exit(0);
}
