#!/usr/bin/env node
/* Tests for the server-side attendance handlers (lib/weekly.js).
 * Focus: the {status,body,changed} contract, attendance seed/upsert + audit, and
 * monthly recompute feeding the ballot. Timestamps are not asserted (handler reads
 * the clock). The Weekly draw + sweep that used to be tested here were retired in
 * 2026-09 (see scripts/test-session-draw-handler.js). */
'use strict';
const W = require('../lib/weekly.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function freshState() {
  return {
    roster: [{ id: 'p6', name: 'Kokyan' }, { id: 'p9', name: 'Shane' }, { id: 'p0', name: 'Thomas' }],
    regulars: { 1: ['p6', 'p9', 'p0'] }, // Monday regulars
    players: [{ id: 'p6', name: 'Kokyan' }], // p6 checked into the live session
    sessions: {}, signups: [], sessionDate: '2026-07-20',
    monthlyDraw: { month: '2026-07', participants: [] },
    attendance: {}, audit: [],
  };
}

// ── seed ──
let s = freshState();
let r = W.handleWeeklyAdminAction(s, { action: 'seedAttendance', date: '2026-07-20' });
check('seed ok/changed', r.status === 200 && r.changed === true);
check('seed added all 3 regulars', r.body.added === 3);
check('seed present=true for session player p6', s.attendance['2026-07-20'].entries.p6.present === true);
check('seed present=false for non-session regular p9', s.attendance['2026-07-20'].entries.p9.present === false);
check('seed never overwrites: re-seed adds 0', W.handleWeeklyAdminAction(s, { action: 'seedAttendance', date: '2026-07-20' }).body.added === 0);

// ── setAttendance + audit ──
r = W.handleWeeklyAdminAction(s, { action: 'setAttendance', date: '2026-07-20', playerId: 'p9', present: true, paid: true });
check('setAttendance changed', r.changed === true && r.body.entry.paid === true);
check('audit recorded present + paid changes', s.audit.filter(a => a.action.startsWith('attendance.')).length >= 2);
r = W.handleWeeklyAdminAction(s, { action: 'setAttendance', date: '2026-07-20', playerId: 'p6', present: true, paid: true });
check('retired weeklyDraw action is rejected', W.handleWeeklyAdminAction(s, { action: 'weeklyDraw', date: '2026-07-20' }).status === 400 && !W.WEEKLY_ADMIN_ACTIONS.has('weeklyDraw'));

// ── monthly recompute feeds participants ──
let s5 = freshState();
for (const d of ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']) {
  W.handleWeeklyAdminAction(s5, { action: 'setAttendance', date: d, playerId: 'p6', name: 'Kokyan', present: true, paid: true });
}
r = W.handleWeeklyAdminAction(s5, { action: 'recomputeMonthly', month: '2026-07' });
check('recompute ok', r.status === 200);
check('p6 in monthly participants as auto entry', (s5.monthlyDraw.participants || []).some(p => p.id === 'p6' && p.auto));

// ── override ──
r = W.handleWeeklyAdminAction(s5, { action: 'setMonthlyOverride', month: '2026-07', playerId: 'p9', eligible: true, reason: 'manual' });
check('override adds ineligible player', r.status === 200 && (s5.monthlyDraw.participants || []).some(p => p.id === 'p9'));

// ── invalid inputs never throw ──
check('bad action -> 400', W.handleWeeklyAdminAction(s5, { action: 'nope' }).status === 400);
check('setAttendance bad date -> 400', W.handleWeeklyAdminAction(s5, { action: 'setAttendance', date: 'x', playerId: 'p6' }).status === 400);
check('null state -> 400 (no throw)', W.handleWeeklyAdminAction(null, { action: 'seedAttendance', date: '2026-07-20' }).status === 400);

console.log(`\nweekly handler: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
