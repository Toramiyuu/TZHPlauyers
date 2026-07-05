#!/usr/bin/env node
/*
 * test-court-pad.js — guard for the "added court has no match slot" fix.
 *
 * A schedule generated for N courts stores exactly N court slots per round. When
 * the admin later ticks an extra court, that court has no slot in
 * rounds[].courts[] and renders as "—" / "No match slot". saveActiveCourts()
 * repairs this via the PURE helper in public/index.html:
 *
 *   padRoundsToCourts(rounds, numCourts)
 *     -> { rounds, changed }   pads every round up to numCourts with empty
 *        ('' = TBD) match slots. Never removes slots. `rounds` is a fresh array
 *        only when a pad happened; inputs are never mutated.
 *
 * Extracts the helper from the inline <script> and asserts its behaviour.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function extractFn(name, src) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  if (braceOpen === -1) return null;
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function load(name) {
  const fnSrc = extractFn(name, html);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}; return ${name};`)();
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const makeRounds = () => ([
  { label: 'Round 1', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
  ] },
  { label: 'Round 2', courts: [
    { team1: ['p8', 'p9'], team2: ['p10', 'p11'] },
    { team1: ['p12', 'p13'], team2: ['p14', 'p15'] },
  ] },
]);

const padRoundsToCourts = load('padRoundsToCourts');
if (!padRoundsToCourts) {
  failures.push('padRoundsToCourts is not defined in public/index.html');
} else {
  // 1. Growing from 2 -> 3 courts adds one empty slot per round.
  {
    const { rounds, changed } = padRoundsToCourts(makeRounds(), 3);
    check('pad: changed flag set when a slot is added', changed === true);
    check('pad: every round now has 3 courts', rounds.every(r => r.courts.length === 3));
    const added = rounds[0].courts[2];
    check('pad: new slot is an empty TBD match',
      JSON.stringify(added) === JSON.stringify({ team1: ['', ''], team2: ['', ''] }));
    check('pad: existing matches untouched', rounds[0].courts[0].team1[0] === 'p0');
    check('pad: labels preserved', rounds[1].label === 'Round 2');
  }
  // 2. numCourts equal to existing count -> no change, same array returned.
  {
    const input = makeRounds();
    const { rounds, changed } = padRoundsToCourts(input, 2);
    check('pad: no change when count already matches', changed === false && rounds === input);
  }
  // 3. Shrinking never removes slots (extra courts are just hidden by callers).
  {
    const { rounds, changed } = padRoundsToCourts(makeRounds(), 1);
    check('pad: shrinking is a no-op (keeps 2 courts)', changed === false && rounds[0].courts.length === 2);
  }
  // 4. Growing by more than one (2 -> 4) pads both new courts.
  {
    const { rounds } = padRoundsToCourts(makeRounds(), 4);
    check('pad: 2 -> 4 pads two courts', rounds[0].courts.length === 4 && rounds[1].courts.length === 4);
  }
  // 5. Purity: the input rounds are not mutated.
  {
    const input = makeRounds();
    padRoundsToCourts(input, 3);
    check('pad: does not mutate input rounds', input[0].courts.length === 2);
  }
  // 6. A round with a missing/garbage courts array is repaired to numCourts.
  {
    const broken = [{ label: 'Round 1' }, { label: 'Round 2', courts: null }];
    const { rounds } = padRoundsToCourts(broken, 2);
    check('pad: missing courts array rebuilt', rounds[0].courts.length === 2 && rounds[1].courts.length === 2);
  }
  // 7. Defensive: empty / undefined rounds -> unchanged, no throw.
  {
    const a = padRoundsToCourts([], 3);
    const b = padRoundsToCourts(undefined, 3);
    check('pad: empty rounds -> {rounds:[],changed:false}', Array.isArray(a.rounds) && a.rounds.length === 0 && a.changed === false);
    check('pad: undefined rounds -> {rounds:[],changed:false}', Array.isArray(b.rounds) && b.changed === false);
  }
}

console.log('test-court-pad — added-court match-slot repair\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  padRoundsToCourts pads rounds up to the active court count');
  console.log('  PASS  existing matches preserved, inputs never mutated');
  console.log('\nRESULT: PASS — all court-pad assertions green.');
  process.exit(0);
}
