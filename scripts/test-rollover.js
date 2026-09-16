#!/usr/bin/env node
/*
 * test-rollover.js — behavioural guard for the automatic session-date rollover
 * (feature added 2026-07-08; moved off midnight to the NIGHT boundary 2026-09-16).
 *
 * Requirement (with the user): the session date advances to the new NIGHT, not
 * to the new calendar day. A night is owned by the day it started, so the
 * Friday social that runs to 12:30am is still Friday — and so is the Saturday
 * afternoon spent tallying its payments. A Vercel cron at 12:00 UTC (20:00 MYT,
 * the hour a game night takes over) hits /api/cron-rollover, which calls
 * rolloverSessionDate(). The night itself is computed by public/night.js and
 * guarded by test-night.js; this file guards the ADVANCE decision only.
 *
 * The DECISION of whether/where to advance is the pure helper
 * nextRolloverDate(sessionDate, night):
 *
 *   - stale live day (sessionDate < night)      → advance to the night
 *   - already on the night                      → null (no-op)
 *   - a FUTURE scheduled day (sessionDate > night) → null (never rewind a
 *     scheduled upcoming session)
 *   - missing sessionDate                       → the night
 *   - missing night (defensive)                 → null
 *
 * Advancing reuses applySessionDateChange, so the outgoing day is snapshotted
 * to history AND its players earn their +2 (see test-session-points.js). This
 * file also checks that a stale-day rollover credits those points.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const path = require('path');
const mod = require(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'));
const nextRolloverDate = mod.nextRolloverDate;
const applySessionDateChange = mod.applySessionDateChange;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// Real game nights, so the dates read the way the venue's week actually runs.
const FRI = '2026-09-18', SUN = '2026-09-20', MON = '2026-09-21', NEXT_FRI = '2026-09-25';

if (typeof nextRolloverDate !== 'function') {
  failures.push('nextRolloverDate is not exported from api/state.js');
} else {
  // 1. A session behind the current night advances to it.
  check('stale day → advances to the night', nextRolloverDate(FRI, SUN) === SUN);

  // 2. Already on the night → no-op.
  check('current night → no advance (null)', nextRolloverDate(SUN, SUN) === null);

  // 3. Future scheduled day → never rewound.
  check('future scheduled day → no advance (null)', nextRolloverDate(NEXT_FRI, SUN) === null);

  // 4. Missing sessionDate → adopt the night.
  check('missing sessionDate → the night', nextRolloverDate('', SUN) === SUN);
  check('undefined sessionDate → the night', nextRolloverDate(undefined, SUN) === SUN);

  // 5. Missing night (defensive) → no-op.
  check('missing night → null', nextRolloverDate(FRI, '') === null);

  // 6. The phantom-Saturday regression: Friday's night runs to 12:30am and owns
  //    all of Saturday, so nothing may ever advance a Friday session to the
  //    19th. night.js never returns an off day; if it somehow did, this is the
  //    line that would notice the session being cut in half again.
  check('Friday never rolls to Saturday', nextRolloverDate(FRI, SUN) !== '2026-09-19');

  // 7. A stale-day rollover, when applied, closes the day AND awards +2.
  {
    const state = {
      sessionDate: SUN,
      players: [{ id: 'p0', name: 'Thomas' }],
      roster: [{ id: 'p0', name: 'Thomas', points: 4 }],
      rounds: [], numCourts: 2, courtNumbers: [1, 2], sessions: {},
    };
    const target = nextRolloverDate(state.sessionDate, MON);
    const r = applySessionDateChange(state, target, MON);
    check('rollover applies to a fresh new night', r.ok && r.state.sessionDate === MON);
    check('rollover snapshots the closed night', !!(r.state.sessions || {})[SUN]);
    check('rollover awards +2 to the night\'s player (4 → 6)',
      (r.state.roster.find(x => x.id === 'p0') || {}).points === 6);
  }
}

console.log('test-rollover — automatic session-date rollover (night boundary, 20:00 MYT)\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  advances only a stale live day; keeps the current night + future scheduled');
  console.log('  PASS  a Friday session is never rolled onto the phantom Saturday');
  console.log('  PASS  applied rollover snapshots the night and awards its points');
  console.log('\nRESULT: PASS — all rollover assertions green.');
  process.exit(0);
}
