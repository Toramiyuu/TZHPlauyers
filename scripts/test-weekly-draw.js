#!/usr/bin/env node
/* Tests for weekly-draw pure logic (public/weekly-draw.js).
 * Covers cutoff/draw instants (MYT), candidate seeding, eligibility (present&&paid),
 * deterministic winner selection, and live status transitions. */
'use strict';
const W = require('../public/weekly-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// 2026-07-20 is a Monday, 07-24 Friday, 07-26 Sunday. Wed of that week = 07-22.
check('weekday: 2026-07-20 is Monday(1)', W.isoWeekday('2026-07-20') === 1);
check('weekday: 2026-07-22 is Wednesday(3)', W.isoWeekday('2026-07-22') === 3);
check('weekday: 2026-07-24 is Friday(5)', W.isoWeekday('2026-07-24') === 5);
check('weekday: 2026-07-26 is Sunday(0)', W.isoWeekday('2026-07-26') === 0);

// onOrAfterWeekday to Wednesday(3)
check('Mon->Wed same week', W.onOrAfterWeekday('2026-07-20', 3) === '2026-07-22');
check('Fri->next Wed', W.onOrAfterWeekday('2026-07-24', 3) === '2026-07-29');
check('Sun->next Wed', W.onOrAfterWeekday('2026-07-26', 3) === '2026-07-29');

// MYT instant: Wed 20:00 MYT for 2026-07-22 == 2026-07-22T12:00:00Z
const drawMs = W.drawsAt('2026-07-20', W.DEFAULT_SETTINGS);
check('drawsAt Monday session = Wed 22 20:00 MYT (=12:00 UTC)',
  new Date(drawMs).toISOString() === '2026-07-22T12:00:00.000Z');
const closeMs = W.closesAt('2026-07-20', W.DEFAULT_SETTINGS);
check('closesAt Monday session = Wed 22 17:00 MYT (=09:00 UTC)',
  new Date(closeMs).toISOString() === '2026-07-22T09:00:00.000Z');

// isDrawable / entriesOpen around the boundary
check('not drawable before draw time', W.isDrawable('2026-07-20', W.DEFAULT_SETTINGS, drawMs - 1) === false);
check('drawable at draw time', W.isDrawable('2026-07-20', W.DEFAULT_SETTINGS, drawMs) === true);
check('entries open before cutoff', W.entriesOpen('2026-07-20', W.DEFAULT_SETTINGS, closeMs - 1) === true);
check('entries closed at cutoff', W.entriesOpen('2026-07-20', W.DEFAULT_SETTINGS, closeMs) === false);

// live status transitions
check('status open before cutoff', W.liveStatus('2026-07-20', W.DEFAULT_SETTINGS, closeMs - 1000, false).code === 'open');
check('status closed between cutoff and draw', W.liveStatus('2026-07-20', W.DEFAULT_SETTINGS, closeMs + 1000, false).code === 'closed');
check('status due after draw time (not drawn)', W.liveStatus('2026-07-20', W.DEFAULT_SETTINGS, drawMs + 1000, false).code === 'due');
check('status drawn when winner exists', W.liveStatus('2026-07-20', W.DEFAULT_SETTINGS, drawMs + 1000, true).code === 'drawn');

// candidate list: session players first, then regulars, deduped
const roster = [
  { id: 'p0', name: 'Thomas' }, { id: 'p1', name: 'Desmond' },
  { id: 'p6', name: 'Kokyan' }, { id: 'p9', name: 'Shane' },
];
const regulars = { 1: ['p6', 'p0'] };            // Monday regulars
const sessionPlayers = [{ id: 'p9', name: 'Shane' }, { id: 'p6', name: 'Kokyan' }];
const cands = W.candidateList(regulars, 1, sessionPlayers, roster);
check('candidate count deduped', cands.length === 3);
check('session players first', cands[0].playerId === 'p9' && cands[0].source === 'session');
check('regular-only player included', cands.some(c => c.playerId === 'p0' && c.source === 'regular'));
check('string weekday key tolerated', W.candidateList({ '1': ['p0'] }, 1, [], roster).length === 1);

// eligibility present&&paid
const entries = {
  p6: { playerId: 'p6', name: 'Kokyan', present: true, paid: true },
  p9: { playerId: 'p9', name: 'Shane', present: true, paid: false },
  p0: { playerId: 'p0', name: 'Thomas', present: false, paid: true },
};
const elig = W.eligibleFromAttendance(entries);
check('eligible only present&&paid', elig.length === 1 && elig[0].playerId === 'p6');
check('reason: unpaid', W.ineligibleReason(entries.p9) === 'Unpaid');
check('reason: absent', W.ineligibleReason(entries.p0) === 'Absent');
check('reason: no record', W.ineligibleReason(undefined) === 'No attendance record');
check('reason: eligible -> empty', W.ineligibleReason(entries.p6) === '');

// deterministic winner
const rngFirst = () => 0;      // pick index 0
const rngLast = () => 0.999;   // pick last index
const many = [{ playerId: 'a', name: 'A' }, { playerId: 'b', name: 'B' }, { playerId: 'c', name: 'C' }];
check('pickWinner rng=0 -> first', W.pickWinner(many, rngFirst).playerId === 'a');
check('pickWinner rng~1 -> last', W.pickWinner(many, rngLast).playerId === 'c');
check('pickWinner empty -> null', W.pickWinner([], rngFirst) === null);

// buildDrawResult
const res = W.buildDrawResult('2026-07-20', 1, entries, rngFirst, 'cron', 1700000000000);
check('buildDrawResult ok with a winner', res.ok === true && res.winner.playerId === 'p6');
check('buildDrawResult eligibleCount', res.eligibleCount === 1);
check('buildDrawResult drawnBy', res.drawnBy === 'cron');
const resEmpty = W.buildDrawResult('2026-07-20', 1, {}, rngFirst, 'cron', 1700000000000);
check('buildDrawResult empty -> ok:false, winner null', resEmpty.ok === false && resEmpty.winner === null);

// tolerant of junk
check('closesAt junk date -> NaN (no throw)', Number.isNaN(W.closesAt('nope', W.DEFAULT_SETTINGS)));
check('candidateList null inputs -> [] (no throw)', W.candidateList(null, 1, null, null).length === 0);

console.log(`\nweekly-draw.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
