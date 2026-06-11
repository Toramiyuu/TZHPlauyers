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

console.log(`\nmonthly-draw tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
