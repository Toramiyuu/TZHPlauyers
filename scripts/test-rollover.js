#!/usr/bin/env node
/*
 * test-rollover.js — behavioural guard for the automatic midnight date rollover
 * (feature added 2026-07-08).
 *
 * Requirement (with the user): each day, at 00:00 Malaysia time, the session
 * date advances to the new day. The server already computes "today" in UTC+8
 * (todayISO honours TZ_OFFSET_HOURS), so a Vercel cron at 16:00 UTC hits
 * /api/cron-rollover which calls rolloverSessionDate().
 *
 * The DECISION of whether/where to advance is the pure helper
 * nextRolloverDate(sessionDate, today):
 *
 *   - stale live day (sessionDate < today)      → advance to today
 *   - already today                             → null (no-op)
 *   - a FUTURE scheduled day (sessionDate > today) → null (never rewind a
 *     scheduled upcoming session)
 *   - missing sessionDate                       → today
 *   - missing today (defensive)                 → null
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

if (typeof nextRolloverDate !== 'function') {
  failures.push('nextRolloverDate is not exported from api/state.js');
} else {
  // 1. Stale live day advances to today.
  check('stale day → advances to today',
    nextRolloverDate('2026-07-07', '2026-07-08') === '2026-07-08');

  // 2. Already today → no-op.
  check('today → no advance (null)',
    nextRolloverDate('2026-07-08', '2026-07-08') === null);

  // 3. Future scheduled day → never rewound.
  check('future scheduled day → no advance (null)',
    nextRolloverDate('2026-07-15', '2026-07-08') === null);

  // 4. Missing sessionDate → default to today.
  check('missing sessionDate → today', nextRolloverDate('', '2026-07-08') === '2026-07-08');
  check('undefined sessionDate → today', nextRolloverDate(undefined, '2026-07-08') === '2026-07-08');

  // 5. Missing today (defensive) → no-op.
  check('missing today → null', nextRolloverDate('2026-07-07', '') === null);

  // 6. A stale-day rollover, when applied, closes the day AND awards +2.
  {
    const state = {
      sessionDate: '2026-07-07',
      players: [{ id: 'p0', name: 'Thomas' }],
      roster: [{ id: 'p0', name: 'Thomas', points: 4 }],
      rounds: [], numCourts: 2, courtNumbers: [1, 2], sessions: {},
    };
    const target = nextRolloverDate(state.sessionDate, '2026-07-08');
    const r = applySessionDateChange(state, target, '2026-07-08');
    check('rollover applies to a fresh new day', r.ok && r.state.sessionDate === '2026-07-08');
    check('rollover snapshots the closed day', !!(r.state.sessions || {})['2026-07-07']);
    check('rollover awards +2 to the day\'s player (4 → 6)',
      (r.state.roster.find(x => x.id === 'p0') || {}).points === 6);
  }
}

console.log('test-rollover — automatic midnight date rollover (00:00 MYT)\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  advances only a stale live day; keeps today + future scheduled');
  console.log('  PASS  applied rollover snapshots the day and awards its points');
  console.log('\nRESULT: PASS — all rollover assertions green.');
  process.exit(0);
}
