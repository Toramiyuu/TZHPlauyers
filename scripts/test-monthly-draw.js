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

console.log(`\nmonthly-draw tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
