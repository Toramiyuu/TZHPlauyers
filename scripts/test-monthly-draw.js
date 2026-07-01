#!/usr/bin/env node
/* TDD tests for the monthly lucky-draw pure logic (public/monthly-draw.js).
 * Model: 1 token = 1 spin; each spin rolls per-prize odds (default 1%/3%/5%, rest = no win). */
'use strict';
const { drawTokens, drawLeftover, spinOutcome, tokensRemaining } = require('../public/monthly-draw.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── tokens = floor(tubes / 4) ──
check('0 -> 0 tokens', drawTokens(0) === 0);
check('3 -> 0 tokens', drawTokens(3) === 0);
check('4 -> 1 token', drawTokens(4) === 1);
check('8 -> 2 tokens', drawTokens(8) === 2);
check('16 -> 4 tokens', drawTokens(16) === 4);
check('negative -> 0', drawTokens(-5) === 0);
check('non-number -> 0', drawTokens('x') === 0);

// ── leftover ──
check('9 -> leftover 1', drawLeftover(9) === 1);
check('13: tokens*4 + leftover == 13', drawTokens(13) * 4 + drawLeftover(13) === 13);

// ── spinOutcome(odds, rng): cumulative bands [first][second][third][none] ──
const odds = { first: 0.01, second: 0.03, third: 0.05 }; // cumulative: .01, .04, .09
check('r=0 -> first', spinOutcome(odds, () => 0) === 'first');
check('r=0.005 -> first', spinOutcome(odds, () => 0.005) === 'first');
check('r=0.01 boundary -> second', spinOutcome(odds, () => 0.01) === 'second');
check('r=0.039 -> second', spinOutcome(odds, () => 0.039) === 'second');
check('r=0.04 boundary -> third', spinOutcome(odds, () => 0.04) === 'third');
check('r=0.089 -> third', spinOutcome(odds, () => 0.089) === 'third');
check('r=0.09 boundary -> none', spinOutcome(odds, () => 0.09) === 'none');
check('r=0.5 -> none', spinOutcome(odds, () => 0.5) === 'none');
check('zero odds -> none', spinOutcome({ first: 0, second: 0, third: 0 }, () => 0) === 'none');
check('invalid odds coerced to 0 -> none', spinOutcome({ first: 'x', second: null, third: undefined }, () => 0.5) === 'none');

// ── spinOutcome distribution (statistical) ──
const counts = { first: 0, second: 0, third: 0, none: 0 };
const N = 200000;
for (let i = 0; i < N; i++) counts[spinOutcome(odds, Math.random)]++;
check('~1% first', Math.abs(counts.first / N - 0.01) < 0.004);
check('~3% second', Math.abs(counts.second / N - 0.03) < 0.006);
check('~5% third', Math.abs(counts.third / N - 0.05) < 0.008);
check('~91% none', Math.abs(counts.none / N - 0.91) < 0.01);

// ── tokensRemaining = floor(tubes / 4); each spin deducts 4 tubes, so spins-left tracks tubes ──
check('12 tubes -> 3 spins', tokensRemaining({ tubes: 12 }) === 3);
check('9 tubes -> 2 spins', tokensRemaining({ tubes: 9 }) === 2);
check('5 tubes -> 1 spin', tokensRemaining({ tubes: 5 }) === 1);
check('3 tubes -> 0 spins', tokensRemaining({ tubes: 3 }) === 0);
check('0 tubes -> 0 spins', tokensRemaining({ tubes: 0 }) === 0);
check('legacy spinsUsed ignored (spins deduct tubes now)', tokensRemaining({ tubes: 8, spinsUsed: 5 }) === 2);

// ── Ballot model: parseDrawCsv / buildBallot / pickWinnerIndex ──
const { parseDrawCsv, buildBallot, pickWinnerIndex } = require('../public/monthly-draw.js');

// parseDrawCsv — full points-sheet header, token column authoritative
const sheetCsv = [
  'Name,Phone number,Points,Purchased Items,Accumulated tubes,Lucky Draw Token,Leftover tubes,Readable purchase summary',
  'Joo,012 498 9778,1984,RCL No.1,16,4,0,- Purchased RCL No.1 16x',
  'Ling,013 433 1010,992,RCL No.1,8,2,0,- Purchased RCL No.1 8x',
  'Harvey,014 306 6392,117,RCL Titanium,1,0,1,- Purchased RCL Titanium 1x',
  '"Yeoh","016 484 9997",237,"Ling Mei DimGray (1x), Ling Mei Golden (1x)",0,0,0,summary',
].join('\n');
const parsed = parseDrawCsv(sheetCsv);
check('csv: 2 eligible participants', parsed.participants.length === 2);
check('csv: 2 skipped (0-token)', parsed.skipped === 2);
check('csv: Joo has 4 tokens', parsed.participants[0].tokens === 4);
check('csv: Joo name + phone mapped', parsed.participants[0].name === 'Joo' && parsed.participants[0].phone === '012 498 9778');
check('csv: quoted comma field does not shift columns', parseDrawCsv(sheetCsv).error === '');

// parseDrawCsv — newline embedded in a quoted field (Excel multi-line cell) must not break rows
const multilineCsv = [
  'Name,Phone number,Accumulated tubes,Lucky Draw Token,Readable purchase summary',
  'Yeoh,016 484 9997,0,0,"- Purchased Ling Mei DimGray 1x',
  '- Purchased Ling Mei Golden 1x"',
  'Tong Hai,016 489 4043,4,1,- Purchased RSL G2 4x',
].join('\n');
const ml = parseDrawCsv(multilineCsv);
check('csv multiline: row after embedded newline still parsed', !!ml.participants.find(p => p.name === 'Tong Hai' && p.tokens === 1));
check('csv multiline: only Tong Hai eligible (Yeoh 0-token)', ml.participants.length === 1);

// parseDrawCsv — fallback to tubes/4 when token column missing
const noTokenCsv = ['Name,Accumulated tubes', 'Claude,12', 'Harvey,4', 'Lee,3'].join('\n');
const pf = parseDrawCsv(noTokenCsv);
check('csv fallback: Claude 12 tubes -> 3 tokens', pf.participants.find(p => p.name === 'Claude').tokens === 3);
check('csv fallback: Harvey 4 tubes -> 1 token', pf.participants.find(p => p.name === 'Harvey').tokens === 1);
check('csv fallback: Lee 3 tubes -> skipped', !pf.participants.find(p => p.name === 'Lee') && pf.skipped === 1);

// parseDrawCsv — error cases
check('csv empty -> error', parseDrawCsv('').error === 'empty');
check('csv no name column -> error', parseDrawCsv('Foo,Bar\n1,2').error === 'no-name-column');

// buildBallot — name repeated per token, excludes winners by id
const parts = [
  { id: 'a', name: 'Joo', tokens: 4 },
  { id: 'b', name: 'Ling', tokens: 2 },
  { id: 'c', name: 'Peter', tokens: 1 },
];
check('ballot: total tickets = sum tokens', buildBallot(parts).length === 7);
check('ballot: Joo appears 4x', buildBallot(parts).filter(p => p.id === 'a').length === 4);
check('ballot: excludes winner by id', buildBallot(parts, ['a']).length === 3);
check('ballot: excluded id absent', !buildBallot(parts, ['a']).some(p => p.id === 'a'));
check('ballot: empty participants -> []', buildBallot([]).length === 0);
check('ballot: 0-token participant contributes nothing', buildBallot([{ id: 'z', name: 'Z', tokens: 0 }]).length === 0);

// pickWinnerIndex — deterministic with injected rng, weighted by repetition
check('pick: rng 0 -> index 0', pickWinnerIndex(7, () => 0) === 0);
check('pick: rng ~1 -> last index', pickWinnerIndex(7, () => 0.999) === 6);
check('pick: empty -> -1', pickWinnerIndex(0) === -1);
{
  const ballot = buildBallot(parts);
  const winner = ballot[pickWinnerIndex(ballot.length, () => 0.5)]; // index 3 -> still Joo (0..3)
  check('pick: weighted ballot resolves to a participant', !!winner && !!winner.name);
}

// ── Draw-overhaul additions (2026-06-28) ───────────────────────────────
const {
  ordinal, withTokens, carryOverParticipants, matchParticipant,
  participantKey, mergeParticipants, nextMonthKey, monthLabel, reindexRanks,
} = require('../public/monthly-draw.js');

// ordinal — covering the 11/12/13 teen trap
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

// withTokens — tokens derived from tubes, tubes preserved
check('withTokens 6 -> 1 token', withTokens({ name: 'H', tubes: 6 }).tokens === 1);
check('withTokens 6 keeps tubes', withTokens({ name: 'H', tubes: 6 }).tubes === 6);
check('withTokens 3 -> 0 token', withTokens({ name: 'H', tubes: 3 }).tokens === 0);

// carryOverParticipants — tubes%4, tokens reset to 0, keep everyone (incl tubes 0)
{
  const co = carryOverParticipants([
    { id: 'a', name: 'Harvey', phone: '', tubes: 6, tokens: 1 },
    { id: 'b', name: 'Zed', tubes: 3, tokens: 0 },
  ]);
  check('carry: Harvey 6 -> 2 tubes', co[0].tubes === 2);
  check('carry: Harvey tokens reset to 0', co[0].tokens === 0);
  check('carry: Zed 3 -> 3 tubes / 0 tokens', co[1].tubes === 3 && co[1].tokens === 0);
  check('carry: keeps everyone (no drop)', co.length === 2);
  check('carry: id preserved', co[0].id === 'a');
}
{
  const co = carryOverParticipants([{ id: 'z', name: 'Zero', tubes: 0, tokens: 0 }]);
  check('carry: tubes=0 person kept at 0', co.length === 1 && co[0].tubes === 0 && co[0].tokens === 0);
}

// matchParticipant — name match; phone as tiebreaker only when both present
check('match: same name (case/space-insensitive), no phones', matchParticipant({ name: ' harvey ' }, { name: 'Harvey' }) === true);
check('match: same name, phones differ -> no match', matchParticipant({ name: 'Harvey', phone: '012 1' }, { name: 'Harvey', phone: '012 2' }) === false);
check('match: same name, same phone (digit-normalised) -> match', matchParticipant({ name: 'Harvey', phone: '014 306 6392' }, { name: 'Harvey', phone: '0143066392' }) === true);
check('match: same name, one phone missing -> match on name', matchParticipant({ name: 'Harvey', phone: '' }, { name: 'Harvey', phone: '014' }) === true);
check('match: different name -> no match', matchParticipant({ name: 'Harvey' }, { name: 'Joo' }) === false);
check('participantKey: name+phone digits', participantKey('Harvey', '014 306 6392') === 'harvey|0143066392');
check('participantKey: name only when no phone', participantKey('Harvey', '') === 'harvey');

// mergeParticipants — add mode sums tubes, matches by identity, appends new, keeps untouched
{
  const existing = [{ id: 'a', name: 'Harvey', phone: '', tubes: 2, tokens: 0 }];
  const incoming = [{ name: 'Harvey', phone: '', tubes: 4, tokens: 1 }, { name: 'NewGuy', phone: '', tubes: 8, tokens: 2 }];
  const merged = mergeParticipants(existing, incoming, { add: true });
  const h = merged.find(p => p.name === 'Harvey');
  const n = merged.find(p => p.name === 'NewGuy');
  check('merge add: Harvey tubes 2+4=6', h.tubes === 6);
  check('merge add: Harvey tokens recomputed = 1', h.tokens === 1);
  check('merge add: Harvey id preserved', h.id === 'a');
  check('merge add: new person appended', !!n && n.tubes === 8 && n.tokens === 2);
  check('merge add: total 2 people', merged.length === 2);
}
{
  const existing = [{ id: 'a', name: 'Harvey', phone: '', tubes: 2, tokens: 0 }];
  const merged = mergeParticipants(existing, [{ name: 'Harvey', tubes: 4 }], { add: false });
  check('merge replace: Harvey tubes set to 4 (not summed)', merged.find(p => p.name === 'Harvey').tubes === 4);
}
{
  const existing = [{ id: 'a', name: 'Harvey', tubes: 2, tokens: 0 }, { id: 'b', name: 'Stay', tubes: 5, tokens: 1 }];
  const merged = mergeParticipants(existing, [{ name: 'Harvey', tubes: 4 }], { add: true });
  check('merge: untouched existing kept', merged.find(p => p.name === 'Stay').tubes === 5);
}

// nextMonthKey / monthLabel — pure date-key math (no Date.now)
check('nextMonthKey 2026-06 -> 2026-07', nextMonthKey('2026-06') === '2026-07');
check('nextMonthKey 2026-12 -> 2027-01', nextMonthKey('2026-12') === '2027-01');
check('nextMonthKey 2026-01 -> 2026-02', nextMonthKey('2026-01') === '2026-02');
check('monthLabel 2026-06 -> June 2026', monthLabel('2026-06') === 'June 2026');
check('monthLabel 2027-01 -> January 2027', monthLabel('2027-01') === 'January 2027');
check('monthLabel 2026-12 -> December 2026', monthLabel('2026-12') === 'December 2026');

// reindexRanks — engagement winner removal re-rank
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

// parseDrawCsv — now also returns tubes (additive; eligibility unchanged)
{
  const p2 = parseDrawCsv(sheetCsv);
  check('csv: Joo tubes mapped from Accumulated tubes (16)', p2.participants[0].tubes === 16);
  check('csv: Ling tubes 8', p2.participants[1].tubes === 8);
}
{
  const noTubes = ['Name,Lucky Draw Token', 'Sam,3'].join('\n');
  const pf2 = parseDrawCsv(noTubes);
  check('csv: tubes fallback tokens*4 (3 tokens -> 12 tubes)', pf2.participants[0].tubes === 12);
}

// ── archiveSummary — normalize a closed-month archive for the "past month" detail view ──
const { archiveSummary } = require('../public/monthly-draw.js');
{
  const arch = {
    label: 'June 2026',
    winners: [
      { rank: 2, name: 'John', prize: 'Racket' },
      { rank: 1, name: 'Ling', prize: 'Shuttles' },
      { rank: 3, name: 'Joo', prize: '' },
    ],
    participants: [{ tubes: 6 }, { tubes: 4 }, { tubes: 3 }, { tubes: 0 }],
  };
  const sum = archiveSummary(arch);
  check('summary: label passed through', sum.label === 'June 2026');
  check('summary: winners sorted by rank', sum.winners.map(w => w.rank).join(',') === '1,2,3');
  check('summary: keeps prize (what they won)', sum.winners[0].prize === 'Shuttles');
  check('summary: winner name after sort', sum.winners[1].name === 'John');
  check('summary: empty prize stays empty', sum.winners[2].prize === '');
  check('summary: participantCount', sum.participantCount === 4);
  // carried = 6%4 + 4%4 + 3%4 + 0%4 = 2 + 0 + 3 + 0 = 5
  check('summary: carriedTubes = sum(tubes % 4)', sum.carriedTubes === 5);
}
{
  const empty = archiveSummary(null);
  check('summary: null-safe', empty.label === '' && empty.winners.length === 0 && empty.participantCount === 0 && empty.carriedTubes === 0);
  const noWinners = archiveSummary({ label: 'May 2026', participants: [{ tubes: 8 }] });
  check('summary: no winners -> empty list', noWinners.winners.length === 0);
  check('summary: no winners still counts participants/carry', noWinners.participantCount === 1 && noWinners.carriedTubes === 0);
}

// ── removeHistoryEntry — admin removes a past draw from the Lucky Draw history ──
const { removeHistoryEntry } = require('../public/monthly-draw.js');
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
