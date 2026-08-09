#!/usr/bin/env node
/* Tests for monthly eligibility pure logic (public/monthly-eligibility.js).
 * Rule: eligible only if attended AND paid EVERY required session (regular weekday
 * occurrences in the month that are <= today). */
'use strict';
const M = require('../public/monthly-eligibility.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// July 2026 Mondays: 06, 13, 20, 27.
check('required Mondays in July (full month)',
  JSON.stringify(M.requiredDatesForMonth('2026-07', [1], '2026-07-31')) ===
  JSON.stringify(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']));
check('required Mondays capped at today (mid-month)',
  JSON.stringify(M.requiredDatesForMonth('2026-07', [1], '2026-07-20')) ===
  JSON.stringify(['2026-07-06', '2026-07-13', '2026-07-20']));
check('bad month -> []', M.requiredDatesForMonth('nope', [1], '2026-07-20').length === 0);

// regular weekdays from regulars map
const regulars = { 1: ['p6', 'p0'], 5: ['p6'], 0: ['p9'] };
check('player regular weekdays', JSON.stringify(M.playerRegularWeekdays(regulars, 'p6')) === JSON.stringify([1, 5]));
check('player with no regulars -> []', M.playerRegularWeekdays(regulars, 'pX').length === 0);

// attendance: Kokyan attended+paid all 4 Mondays -> eligible
const attFull = {
  '2026-07-06': { entries: { p6: { present: true, paid: true } } },
  '2026-07-13': { entries: { p6: { present: true, paid: true } } },
  '2026-07-20': { entries: { p6: { present: true, paid: true } } },
  '2026-07-27': { entries: { p6: { present: true, paid: true } } },
};
const recEligible = M.computePlayerEligibility('p6', 'Kokyan', [1], attFull, '2026-07', '2026-07-31');
check('all present+paid -> eligible', recEligible.eligible === true);
check('attendedCount 4/4', recEligible.attendedCount === 4 && recEligible.requiredCount === 4);
check('eligible reason empty', recEligible.reason === '');
check('breakdown all counted', recEligible.breakdown.every(b => b.counted));

// missed one payment -> not eligible, reason names the date
const attUnpaid = JSON.parse(JSON.stringify(attFull));
attUnpaid['2026-07-13'].entries.p6.paid = false;
const recUnpaid = M.computePlayerEligibility('p6', 'Kokyan', [1], attUnpaid, '2026-07', '2026-07-31');
check('one unpaid -> not eligible', recUnpaid.eligible === false);
check('reason: payment missing for 2026-07-13', recUnpaid.reason === 'Payment missing for 2026-07-13');
check('attendedCount 3/4', recUnpaid.attendedCount === 3);

// missed attendance -> reason absent
const attAbsent = JSON.parse(JSON.stringify(attFull));
attAbsent['2026-07-20'].entries.p6.present = false;
const recAbsent = M.computePlayerEligibility('p6', 'Kokyan', [1], attAbsent, '2026-07', '2026-07-31');
check('one absent -> not eligible', recAbsent.eligible === false);
check('reason: absent on 2026-07-20', recAbsent.reason === 'Absent on 2026-07-20');

// no records at all -> not eligible
const recNone = M.computePlayerEligibility('p6', 'Kokyan', [1], {}, '2026-07', '2026-07-31');
check('no records -> not eligible', recNone.eligible === false);
check('reason: absent on first date', recNone.reason === 'Absent on 2026-07-06');

// compute whole month + only players with a regular schedule
const roster = [{ id: 'p6', name: 'Kokyan' }, { id: 'p9', name: 'Shane' }, { id: 'pX', name: 'Guest' }];
const monthAtt = {
  '2026-07-06': { entries: { p6: { present: true, paid: true } } },
  '2026-07-13': { entries: { p6: { present: true, paid: true } } },
};
const regularsMon = { 1: ['p6'], 0: ['p9'] }; // p6 Mondays only, p9 Sundays only
const month = M.computeMonthEligibility({ roster, regulars: regularsMon, attendance: monthAtt, month: '2026-07', todayISO: '2026-07-13', computedBy: 'cron', nowMs: 1700000000000 });
check('only players with regulars considered', month.players.length === 2); // p6, p9 (pX has none)
check('computedBy carried', month.computedBy === 'cron');
const p6rec = month.players.find(p => p.playerId === 'p6');
check('p6 eligible so far (2/2 Mondays)', p6rec.eligible === true);

// override preserved + effectiveEligible
const withOverride = M.computeMonthEligibility({
  roster, regulars, attendance: {}, month: '2026-07', todayISO: '2026-07-31',
  prevPlayers: [{ playerId: 'p6', override: { eligible: true, by: 'admin', reason: 'CSV' } }],
});
const p6ov = withOverride.players.find(p => p.playerId === 'p6');
check('override preserved across recompute', p6ov.override && p6ov.override.eligible === true);
check('effectiveEligible respects override', M.effectiveEligible(p6ov) === true);
check('effectiveEligible no override -> base', M.effectiveEligible({ eligible: false }) === false);

// merge into participants: auto entries for eligible, manual preserved
const existing = [{ id: 'mX', name: 'Manual Person', tubes: 8, tokens: 2 }];
const eligPlayers = [
  { playerId: 'p6', name: 'Kokyan', eligible: true, override: null },
  { playerId: 'p9', name: 'Shane', eligible: false, override: null },
];
const merged = M.mergeEligibilityIntoParticipants(existing, eligPlayers);
check('merge keeps manual', merged.some(p => p.id === 'mX' && !p.auto));
check('merge adds eligible auto', merged.some(p => p.id === 'p6' && p.auto && p.tokens === 1));
check('merge skips ineligible', !merged.some(p => p.id === 'p9'));
// recompute idempotent: re-merging replaces auto set, keeps manual
const merged2 = M.mergeEligibilityIntoParticipants(merged, eligPlayers);
check('merge idempotent (no auto dupes)', merged2.filter(p => p.id === 'p6').length === 1);

console.log(`\nmonthly-eligibility.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
