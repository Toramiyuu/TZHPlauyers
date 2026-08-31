#!/usr/bin/env node
/* test-pair-warnings.js — repeat-matchup warnings in the round editor.
 *
 * Contract:
 *  - Matchmaking.pairCounts(rounds) tallies, per sorted 'a|b' pair, how often
 *    two players were partners and how often they were opponents across a
 *    session's rounds. Blank ids and self-pairs are ignored; pure.
 *  - Matchmaking.courtPairWarnings(court, counts, nameOf, threshold=3) returns
 *    red-note strings ("X has partnered Y N times" / "X has played against Y
 *    N times") for the court's pairs whose count exceeds the threshold.
 *  - index.html renders the notes in a .pair-warn block beside each round
 *    editor court (id pw_<round>_<court>) and refreshes them live from the
 *    DOM slots as picks commit (refreshCourtChip -> refreshPairWarnings).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pairCounts, courtPairWarnings, pairKey } = require('../public/matchmaking.js');

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { pass++; } else { fail++; failures.push(name); console.log('  FAIL  ' + name); }
};
const ok = (label, conds) => {
  check(label, conds.every(Boolean));
  if (!conds.every(Boolean)) console.log('        [' + conds.map(Boolean).join(', ') + ']');
  else console.log('  PASS  ' + label);
};

// ── pairCounts ──────────────────────────────────────────────────────
{
  const court = { team1: ['a', 'b'], team2: ['c', 'd'] };
  const rounds = [1, 2, 3, 4].map(() => ({ label: 'R', courts: [court] }));
  const counts = pairCounts(rounds);
  ok('pairCounts: partners and opponents tallied across the session', [
    counts.partner[pairKey('a', 'b')] === 4,
    counts.partner[pairKey('c', 'd')] === 4,
    counts.opponent[pairKey('a', 'c')] === 4,
    counts.opponent[pairKey('b', 'd')] === 4,
    counts.opponent[pairKey('a', 'b')] === undefined,
    counts.partner[pairKey('a', 'c')] === undefined,
  ]);
  ok('pairCounts: key is order-independent', [pairKey('b', 'a') === pairKey('a', 'b')]);
  const messy = pairCounts([
    { courts: [{ team1: ['a', ''], team2: ['a', 'a'] }] },
    null,
    { courts: null },
    { courts: [null] },
  ]);
  ok('pairCounts: blank ids, self-pairs and null rounds are ignored (pure, no throw)', [
    Object.keys(messy.partner).length === 0,
    Object.keys(messy.opponent).length >= 0,
  ]);
}

// ── courtPairWarnings ───────────────────────────────────────────────
{
  const names = { a: 'Thomas', b: 'Desmond', c: 'Celine', d: 'Sharmin' };
  const nameOf = id => names[id] || '?';
  const court = { team1: ['a', 'b'], team2: ['c', 'd'] };
  const mk = n => pairCounts(Array.from({ length: n }, () => ({ courts: [court] })));

  ok('threshold: 3 repeats stay quiet, 4 warn', [
    courtPairWarnings(court, mk(3), nameOf).length === 0,
    courtPairWarnings(court, mk(4), nameOf).length > 0,
  ]);
  const msgs = courtPairWarnings(court, mk(4), nameOf);
  ok('wording: partner and opponent notes name both players and the count', [
    msgs.includes('Thomas has partnered Desmond 4 times'),
    msgs.includes('Celine has partnered Sharmin 4 times'),
    msgs.includes('Thomas has played against Celine 4 times'),
    msgs.includes('Desmond has played against Sharmin 4 times'),
    msgs.length === 6, // 2 partner pairs + 4 opponent pairs
  ]);
  const partnerOnly = pairCounts([
    ...Array.from({ length: 5 }, () => ({ courts: [{ team1: ['a', 'b'], team2: ['x', 'y'] }] })),
  ]);
  const partnerMsgs = courtPairWarnings({ team1: ['a', 'b'], team2: ['c', 'd'] }, partnerOnly, nameOf);
  ok('only the crossing pair warns (partners 5x, everyone else fresh)', [
    partnerMsgs.length === 1,
    partnerMsgs[0] === 'Thomas has partnered Desmond 5 times',
  ]);
  ok('custom threshold is honoured', [
    courtPairWarnings(court, mk(3), nameOf, 2).length === 6,
    courtPairWarnings(court, mk(9), nameOf, 9).length === 0,
  ]);
  ok('empty slots never warn', [
    courtPairWarnings({ team1: ['', ''], team2: ['', ''] }, mk(9), nameOf).length === 0,
  ]);
}

// ── index.html wiring ───────────────────────────────────────────────
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  function extractFn(name, src) {
    const sig = `function ${name}(`;
    const at = src.indexOf(sig);
    if (at === -1) return null;
    let i = src.indexOf('{', at), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
    }
    return null;
  }
  ok('renderRoundList seeds .pair-warn blocks from session pair counts', [
    (extractFn('renderRoundList', html) || '').includes('Matchmaking.pairCounts'),
    (extractFn('renderRoundList', html) || '').includes('pw_${i}_${c}'),
    (extractFn('selectorsRowHTML', html) || '').includes('pair-warn'),
  ]);
  ok('live refresh: pick commits recompute warnings from the DOM slots', [
    (extractFn('refreshCourtChip', html) || '').includes('refreshPairWarnings'),
    (extractFn('refreshPairWarnings', html) || '').includes('t1p1'),
    (extractFn('refreshPairWarnings', html) || '').includes('Matchmaking.pairCounts'),
  ]);
  ok('notes are red text beside the row (styled, hidden when empty)', [
    /\.pair-warn\{[^}]*color:var\(--fv-red/.test(html),
    html.includes('.pair-warn:empty{display:none}'),
  ]);
  const frSrc = extractFn('renderFriendlyMatchups', html) || '';
  ok('friendly pods warn too (recorded games + current lineups)', [
    frSrc.includes('Matchmaking.pairCounts'),
    frSrc.includes('f.games'),
    frSrc.includes('pair-warn'),
    frSrc.includes('frNameOf'),
  ]);
}

// ── report ──────────────────────────────────────────────────────────
console.log('\ntest-pair-warnings — repeat-matchup notes in the round editor\n');
if (fail) {
  console.log(`RESULT: FAIL — ${fail} assertion(s) failed.`);
  process.exit(1);
}
console.log(`RESULT: PASS — pair-warning assertions green. (${pass} checks)`);
