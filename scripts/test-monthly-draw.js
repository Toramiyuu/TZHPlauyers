#!/usr/bin/env node
/* Tests for the pure helpers in public/monthly-draw.js.
 *
 * The file is named for the Shuttlecock token-ballot draw, which was removed in
 * 2026-09 along with its ballot logic (tokens, spin odds, CSV import, ballot
 * building, participant carry-over). What remains — and what is covered here —
 * is the month/ordinal maths and the rank re-indexing other features still use.
 * Sign-up / join-flow validators have their own suite (test-signups.js).
 */
'use strict';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const {
  ordinal, nextMonthKey, monthLabel, reindexRanks, removeHistoryEntry,
} = require('../public/monthly-draw.js');

// ── ordinal — covering the 11/12/13 teen trap ──
check('ordinal 1 -> 1st', ordinal(1) === '1st');
check('ordinal 2 -> 2nd', ordinal(2) === '2nd');
check('ordinal 3 -> 3rd', ordinal(3) === '3rd');
check('ordinal 4 -> 4th', ordinal(4) === '4th');
check('ordinal 11 -> 11th', ordinal(11) === '11th');
check('ordinal 12 -> 12th', ordinal(12) === '12th');
check('ordinal 13 -> 13th', ordinal(13) === '13th');
check('ordinal 21 -> 21st', ordinal(21) === '21st');
check('ordinal 22 -> 22nd', ordinal(22) === '22nd');
check('ordinal 23 -> 23rd', ordinal(23) === '23rd');
check('ordinal 111 -> 111th', ordinal(111) === '111th');
check('ordinal 112 -> 112th', ordinal(112) === '112th');

// ── nextMonthKey / monthLabel — pure date-key math (no Date.now) ──
check('nextMonthKey 2026-06 -> 2026-07', nextMonthKey('2026-06') === '2026-07');
check('nextMonthKey 2026-12 -> 2027-01', nextMonthKey('2026-12') === '2027-01');
check('nextMonthKey 2026-01 -> 2026-02', nextMonthKey('2026-01') === '2026-02');
check('monthLabel 2026-06 -> June 2026', monthLabel('2026-06') === 'June 2026');
check('monthLabel 2027-01 -> January 2027', monthLabel('2027-01') === 'January 2027');
check('monthLabel 2026-12 -> December 2026', monthLabel('2026-12') === 'December 2026');

// ── reindexRanks — winner removal re-rank ──
{
  const after = reindexRanks([{ rank: 1, name: 'A' }, { rank: 3, name: 'C' }]); // removed rank 2
  check('reindex: ranks become 1,2', after[0].rank === 1 && after[1].rank === 2);
  check('reindex: order preserved (A,C)', after[0].name === 'A' && after[1].name === 'C');
}
{
  const after = reindexRanks([{ rank: 2, name: 'B' }, { rank: 3, name: 'C' }]); // removed rank 1
  check('reindex: removing rank1 of [1,2,3] -> [1,2]', after.length === 2 && after[0].rank === 1 && after[1].rank === 2);
  check('reindex: first becomes old rank2 (B)', after[0].name === 'B');
}

// ── removeHistoryEntry — admin removes a past draw from the history ──
{
  const hist = [
    { date: '2026-07-01', winners: [{ rank: 1, name: 'Jian' }] },
    { date: '2026-06-28', winners: [{ rank: 1, name: 'Karine' }] },
    { date: '2026-06-21', winners: [{ rank: 1, name: 'Milo' }] },
  ];
  const after = removeHistoryEntry(hist, 1);
  check('removeHistory: drops the targeted entry', after.length === 2);
  check('removeHistory: keeps the others in order', after[0].date === '2026-07-01' && after[1].date === '2026-06-21');
  check('removeHistory: does not mutate the original', hist.length === 3);
  check('removeHistory: returns a new array', after !== hist);
}
{
  const hist = [{ date: '2026-07-01' }];
  check('removeHistory: out-of-range idx -> unchanged copy', removeHistoryEntry(hist, 5).length === 1);
  check('removeHistory: negative idx -> unchanged copy', removeHistoryEntry(hist, -1).length === 1);
  check('removeHistory: null history -> []', removeHistoryEntry(null, 0).length === 0);
  check('removeHistory: removing only entry -> []', removeHistoryEntry(hist, 0).length === 0);
}

console.log(`\nmonthly-draw tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
