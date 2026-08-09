#!/usr/bin/env node
/* Tests for the server-side weekly handlers + auto-draw sweep (api/weekly.js).
 * Focus: the {status,body,changed} contract, attendance upsert + audit, draw +
 * confirm-guarded rerun, cron sweep idempotency, and monthly recompute feeding
 * the ballot. Timestamps are not asserted (handler reads the clock). */
'use strict';
const W = require('../api/weekly.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function freshState() {
  return {
    roster: [{ id: 'p6', name: 'Kokyan' }, { id: 'p9', name: 'Shane' }, { id: 'p0', name: 'Thomas' }],
    regulars: { 1: ['p6', 'p9', 'p0'] }, // Monday regulars
    players: [{ id: 'p6', name: 'Kokyan' }], // p6 checked into the live session
    sessions: {}, signups: [], sessionDate: '2026-07-20',
    monthlyDraw: { month: '2026-07', participants: [] },
    attendance: {}, weeklyDraws: {}, weeklySettings: { ...W.DEFAULT_WEEKLY_SETTINGS }, audit: [],
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

// ── draw ──
r = W.handleWeeklyAdminAction(s, { action: 'weeklyDraw', date: '2026-07-20' });
check('draw ok', r.status === 200 && r.body.ok === true);
check('draw winner is eligible (p6 or p9)', ['p6', 'p9'].includes(r.body.result.winner.playerId));
check('draw eligibleCount 2', r.body.result.eligibleCount === 2);
check('draw status drawn', s.weeklyDraws['2026-07-20'].status === 'drawn');
check('draw has spin descriptor for reveal', !!s.weeklyDraws['2026-07-20'].spin);
check('draw history length 1', s.weeklyDraws['2026-07-20'].history.length === 1);

// ── rerun needs confirm ──
r = W.handleWeeklyAdminAction(s, { action: 'weeklyDraw', date: '2026-07-20' });
check('rerun without confirm -> 409 needsConfirm', r.status === 409 && r.body.needsConfirm === true);
r = W.handleWeeklyAdminAction(s, { action: 'weeklyDraw', date: '2026-07-20', confirm: true });
check('rerun with confirm ok', r.status === 200 && r.body.ok === true);
check('rerun increments rerunCount', s.weeklyDraws['2026-07-20'].rerunCount === 1);
check('rerun appends history', s.weeklyDraws['2026-07-20'].history.length === 2);

// ── draw with no eligible -> ok:false, not drawn ──
let s2 = freshState();
W.handleWeeklyAdminAction(s2, { action: 'seedAttendance', date: '2026-07-20' }); // present but unpaid
r = W.handleWeeklyAdminAction(s2, { action: 'weeklyDraw', date: '2026-07-20' });
check('no eligible -> ok:false, not changed', r.body.ok === false && r.changed === false);
check('no eligible -> not marked drawn', !s2.weeklyDraws['2026-07-20']);

// ── cron sweep idempotency ──
let s3 = freshState();
W.handleWeeklyAdminAction(s3, { action: 'seedAttendance', date: '2026-07-20' });
W.handleWeeklyAdminAction(s3, { action: 'setAttendance', date: '2026-07-20', playerId: 'p6', present: true, paid: true });
// draw time for Monday 2026-07-20 = Wed 2026-07-22 20:00 MYT
const WD = require('../public/weekly-draw.js');
const drawMs = WD.drawsAt('2026-07-20', W.DEFAULT_WEEKLY_SETTINGS, 8);
let sweep = W.sweepWeeklyDraws(s3, { nowMs: drawMs - 1000, offsetHours: 8 });
check('sweep before draw time -> nothing drawn', sweep.drawn.length === 0);
sweep = W.sweepWeeklyDraws(s3, { nowMs: drawMs + 1000, offsetHours: 8, rng: () => 0 });
check('sweep at/after draw time -> draws it', sweep.drawn.length === 1 && sweep.drawn[0] === '2026-07-20');
check('sweep marks drawnBy cron', s3.weeklyDraws['2026-07-20'].drawnBy === 'cron');
const sweep2 = W.sweepWeeklyDraws(s3, { nowMs: drawMs + 5000, offsetHours: 8, rng: () => 0 });
check('sweep idempotent -> second run draws nothing', sweep2.drawn.length === 0);

// ── settings validation ──
let s4 = freshState();
r = W.handleWeeklyAdminAction(s4, { action: 'weeklyDrawSettings', draw: { weekday: 4, time: '21:30' } });
check('settings updated', s4.weeklySettings.draw.weekday === 4 && s4.weeklySettings.draw.time === '21:30');
r = W.handleWeeklyAdminAction(s4, { action: 'weeklyDrawSettings', draw: { weekday: 9, time: '99:99' } });
check('settings reject bad values (kept previous)', s4.weeklySettings.draw.weekday === 4 && s4.weeklySettings.draw.time === '21:30');

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
