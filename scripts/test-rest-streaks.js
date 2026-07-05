#!/usr/bin/env node
/*
 * test-rest-streaks.js — behavioural guard for the admin "bench watch" feature.
 *
 * The admin's "Resting this round" strip flags players who have not played for a
 * run of rounds, colouring each chip redder the longer they have sat out (red
 * begins at 2 rounds). The non-DOM logic lives in two PURE helpers inside
 * public/index.html:
 *
 *   computeRestStreaks(rounds, players, uptoRound)
 *     -> { [playerId]: streak }   consecutive rounds ending at (and including)
 *        uptoRound that the player did NOT appear on any court. Active in
 *        uptoRound => 0. Never appears through uptoRound => uptoRound+1.
 *
 *   restHeatLevel(streak)
 *     -> integer 0..4   redness ramp. 0/1 -> 0 (no tint); 2 -> 1, 3 -> 2,
 *        4 -> 3, 5+ -> 4 (capped).
 *
 * This test extracts each helper from the inline <script> and asserts its
 * behaviour. Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ── extract a top-level function's source by brace matching ─────────
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
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

// fixtures ----------------------------------------------------------------
// 2 courts. p0..p3 play every round; p4/p5 rotate; p9 never plays.
//   Round 0: court0 p0,p1 v p2,p3   court1 p4,p5 v p6,p7      (resting: p8,p9,...)
//   Round 1: court0 p0,p1 v p2,p3   court1 p8,p6 v p7,p10     (p4,p5 now resting)
//   Round 2: court0 p0,p1 v p2,p3   court1 p4,p11 v p12,p13   (p4 back; p5 still resting)
const makeRounds = () => ([
  { label: 'Round 1', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
  ] },
  { label: 'Round 2', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p8', 'p6'], team2: ['p7', 'p10'] },
  ] },
  { label: 'Round 3', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p4', 'p11'], team2: ['p12', 'p13'] },
  ] },
]);
const players = ['p0','p1','p2','p3','p4','p5','p6','p7','p8','p9','p10']
  .map(id => ({ id, name: id }));

// ── computeRestStreaks ────────────────────────────────────────────
{
  const computeRestStreaks = load('computeRestStreaks');
  if (!computeRestStreaks) {
    failures.push('computeRestStreaks is not defined in public/index.html');
  } else {
    // 1. Up to round 2 (whole schedule).
    {
      const s = computeRestStreaks(makeRounds(), players, 2);
      check('rest: constant player scores 0', s.p0 === 0);
      // p5 played round 0, rested rounds 1 & 2 -> streak 2.
      check('rest: p5 sat out last 2 rounds -> 2', s.p5 === 2);
      // p4 played round 0, rested round 1, played round 2 -> streak 0 (played uptoRound).
      check('rest: p4 played the current round -> 0', s.p4 === 0);
      // p6 played rounds 0 & 1, rested round 2 -> streak 1.
      check('rest: p6 rested only the current round -> 1', s.p6 === 1);
      // p9 never appears anywhere -> every round so far = 3.
      check('rest: never-played p9 -> uptoRound+1 (3)', s.p9 === 3);
      // p8 played round 1, rested round 2 -> streak 1.
      check('rest: p8 rested only round 2 -> 1', s.p8 === 1);
    }
    // 2. uptoRound clamps how far we look back (only round 0 in play).
    {
      const s = computeRestStreaks(makeRounds(), players, 0);
      check('rest@round0: p4 active in round 0 -> 0', s.p4 === 0);
      check('rest@round0: p8 resting round 0 -> 1', s.p8 === 1);
      check('rest@round0: p9 never played -> 1', s.p9 === 1);
    }
    // 3. Empty ('') slots never count as a player playing.
    {
      const rounds = makeRounds();
      rounds[2].courts[1] = { team1: ['', ''], team2: ['', ''] };
      const s = computeRestStreaks(rounds, [{ id: 'p4', name: 'p4' }], 2);
      // p4 played round 0, rested round 1, and round 2 is now all-empty -> 2.
      check('rest: empty slots do not reset a streak', s.p4 === 2);
    }
    // 4. uptoRound out of range is clamped to the last round.
    {
      const s = computeRestStreaks(makeRounds(), players, 99);
      check('rest: uptoRound > last is clamped', s.p9 === 3);
    }
    // 5. uptoRound omitted defaults to the last round.
    {
      const s = computeRestStreaks(makeRounds(), players);
      check('rest: default uptoRound = last round', s.p5 === 2 && s.p9 === 3);
    }
    // 6. Purity: inputs not mutated.
    {
      const r = makeRounds();
      computeRestStreaks(r, players, 2);
      check('rest: does not mutate rounds', r[0].courts[0].team1[0] === 'p0');
    }
    // 7. Defensive: empty / undefined inputs -> {}.
    {
      check('rest: empty rounds -> {}', Object.keys(computeRestStreaks([], players, 0)).length === 0);
      check('rest: undefined rounds -> {}', Object.keys(computeRestStreaks(undefined, players, 0)).length === 0);
      check('rest: undefined players -> {}', Object.keys(computeRestStreaks(makeRounds(), undefined, 0)).length === 0);
    }
  }
}

// ── restHeatLevel ─────────────────────────────────────────────────
{
  const restHeatLevel = load('restHeatLevel');
  if (!restHeatLevel) {
    failures.push('restHeatLevel is not defined in public/index.html');
  } else {
    check('heat: 0 rounds -> level 0', restHeatLevel(0) === 0);
    check('heat: 1 round  -> level 0 (no tint below 2)', restHeatLevel(1) === 0);
    check('heat: 2 rounds -> level 1 (red begins)', restHeatLevel(2) === 1);
    check('heat: 3 rounds -> level 2', restHeatLevel(3) === 2);
    check('heat: 4 rounds -> level 3', restHeatLevel(4) === 3);
    check('heat: 5 rounds -> level 4 (cap)', restHeatLevel(5) === 4);
    check('heat: 9 rounds -> level 4 (still capped)', restHeatLevel(9) === 4);
    check('heat: garbage -> level 0', restHeatLevel(undefined) === 0 && restHeatLevel(NaN) === 0);
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-rest-streaks — admin bench-watch logic\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  computeRestStreaks counts consecutive rounds sat out');
  console.log('  PASS  restHeatLevel ramps redness from 2 rounds (capped at 4)');
  console.log('\nRESULT: PASS — all bench-watch assertions green.');
  process.exit(0);
}
