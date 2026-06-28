#!/usr/bin/env node
/*
 * test-next-up.js — behavioural guard for the "Up Next" feature.
 *
 * The viewer shows an "Up Next" panel (the round AFTER each court's current
 * one), with admin controls to advance every court, override the next round's
 * players, and click a row to advance a single court. The non-DOM logic lives
 * in three PURE helpers inside public/index.html:
 *
 *   computeNextUp(rounds, courtRounds, numCourts)
 *     -> [{ court, roundIndex, match }]   (one entry per court that HAS a next
 *                                          round; courts on their last round or
 *                                          with no court slot are omitted)
 *
 *   nextCourtRounds(courtRounds, total)
 *     -> new array advancing each court +1, clamped to the last round index
 *        (total-1); preserves per-court offsets.
 *
 *   applyNextUpEdits(rounds, edits)
 *     -> { rounds, duplicates }   applies per-court next-round edits onto a
 *        CLONE of rounds and reports duplicate player ids scoped PER next-round
 *        index (a player in two courts sharing one next-round index is a
 *        duplicate; the same player in two DIFFERENT next-round indices is not).
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
// 2 courts. Round 0 (current for both), round 1, round 2.
const makeRounds = () => ([
  { label: 'Round 1', courts: [
    { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
  ] },
  { label: 'Round 2', courts: [
    { team1: ['p8', 'p9'], team2: ['p10', 'p11'] },
    { team1: ['p12', 'p13'], team2: ['p14', 'p15'] },
  ] },
  { label: 'Round 3', courts: [
    { team1: ['p0', 'p2'], team2: ['p4', 'p6'] },
    { team1: ['p1', 'p3'], team2: ['p5', 'p7'] },
  ] },
]);

// ── computeNextUp ─────────────────────────────────────────────────
{
  const computeNextUp = load('computeNextUp');
  if (!computeNextUp) {
    failures.push('computeNextUp is not defined in public/index.html');
  } else {
    // 1. Both courts on round 0 -> both have next round (index 1).
    {
      const rows = computeNextUp(makeRounds(), [0, 0], 2);
      check('computeNextUp: two rows when both have a next round', rows.length === 2);
      check('computeNextUp: roundIndex is current+1', rows[0].roundIndex === 1 && rows[1].roundIndex === 1);
      check('computeNextUp: court index carried', rows[0].court === 0 && rows[1].court === 1);
      check('computeNextUp: match is the next round court object',
        rows[0].match.team1[0] === 'p8' && rows[1].match.team2[1] === 'p15');
    }
    // 2. Per-court offsets respected (court 0 on round 1 -> next 2; court 1 on round 0 -> next 1).
    {
      const rows = computeNextUp(makeRounds(), [1, 0], 2);
      check('computeNextUp: respects per-court offset', rows[0].roundIndex === 2 && rows[1].roundIndex === 1);
    }
    // 3. Court on the LAST round is omitted (court 0 on round 2 = last; court 1 on round 0).
    {
      const rows = computeNextUp(makeRounds(), [2, 0], 2);
      check('computeNextUp: court on last round omitted', rows.length === 1 && rows[0].court === 1);
    }
    // 4. ALL courts on last round -> empty (panel hides).
    {
      const rows = computeNextUp(makeRounds(), [2, 2], 2);
      check('computeNextUp: all on last round -> empty', rows.length === 0);
    }
    // 5. Missing court slot in the next round is skipped.
    {
      const r = makeRounds();
      r[1].courts[1] = undefined;
      const rows = computeNextUp(r, [0, 0], 2);
      check('computeNextUp: missing next court slot skipped', rows.length === 1 && rows[0].court === 0);
    }
    // 6. Defensive: empty / undefined inputs -> [].
    {
      check('computeNextUp: empty rounds -> []', Array.isArray(computeNextUp([], [0], 1)) && computeNextUp([], [0], 1).length === 0);
      check('computeNextUp: undefined rounds -> []', Array.isArray(computeNextUp(undefined, [0], 1)) && computeNextUp(undefined, [0], 1).length === 0);
      check('computeNextUp: undefined courtRounds -> []', computeNextUp(makeRounds(), undefined, 2).length === 0);
    }
    // 7. Purity: inputs not mutated.
    {
      const r = makeRounds();
      const cr = [0, 0];
      computeNextUp(r, cr, 2);
      check('computeNextUp: does not mutate rounds', r[1].courts[0].team1[0] === 'p8');
      check('computeNextUp: does not mutate courtRounds', cr[0] === 0 && cr.length === 2);
    }
  }
}

// ── nextCourtRounds ───────────────────────────────────────────────
{
  const nextCourtRounds = load('nextCourtRounds');
  if (!nextCourtRounds) {
    failures.push('nextCourtRounds is not defined in public/index.html');
  } else {
    // 1. Both courts advance +1.
    {
      const out = nextCourtRounds([0, 0], 3);
      check('nextCourtRounds: both advance +1', out[0] === 1 && out[1] === 1);
    }
    // 2. Per-court offsets preserved.
    {
      const out = nextCourtRounds([1, 0], 3);
      check('nextCourtRounds: preserves offsets', out[0] === 2 && out[1] === 1);
    }
    // 3. Clamped at last round index (total-1).
    {
      const out = nextCourtRounds([2, 0], 3);
      check('nextCourtRounds: clamps court already at last', out[0] === 2 && out[1] === 1);
    }
    // 4. All at last round -> unchanged (caller treats as no-op).
    {
      const cur = [2, 2];
      const out = nextCourtRounds(cur, 3);
      check('nextCourtRounds: all at last -> unchanged', out[0] === 2 && out[1] === 2);
    }
    // 5. Purity: input not mutated, new array returned.
    {
      const cur = [0, 1];
      const out = nextCourtRounds(cur, 3);
      check('nextCourtRounds: does not mutate input', cur[0] === 0 && cur[1] === 1);
      check('nextCourtRounds: returns a new array', out !== cur);
    }
    // 6. Defensive: empty / undefined -> [].
    {
      check('nextCourtRounds: empty -> []', Array.isArray(nextCourtRounds([], 3)) && nextCourtRounds([], 3).length === 0);
      check('nextCourtRounds: undefined -> []', Array.isArray(nextCourtRounds(undefined, 3)) && nextCourtRounds(undefined, 3).length === 0);
    }
  }
}

// ── applyNextUpEdits ──────────────────────────────────────────────
{
  const applyNextUpEdits = load('applyNextUpEdits');
  if (!applyNextUpEdits) {
    failures.push('applyNextUpEdits is not defined in public/index.html');
  } else {
    // 1. Shared next-round index: same player in two courts of one round -> duplicate.
    {
      const edits = [
        { court: 0, roundIndex: 1, team1: ['pX', 'p1'], team2: ['p2', 'p3'] },
        { court: 1, roundIndex: 1, team1: ['pX', 'p5'], team2: ['p6', 'p7'] },
      ];
      const { duplicates } = applyNextUpEdits(makeRounds(), edits);
      const dup1 = duplicates.find(d => d.roundIndex === 1);
      check('applyNextUpEdits: shared-index duplicate detected', !!dup1 && dup1.ids.includes('pX'));
    }
    // 2. Different next-round indices: same player in two DIFFERENT rounds -> allowed.
    //    Use players that don't collide with the UNEDITED courts of each round
    //    (round 1 court0 = p8..p11; round 2 court1 = p1,p3,p5,p7).
    {
      const edits = [
        { court: 0, roundIndex: 2, team1: ['pX', 'pA'], team2: ['pB', 'pC'] },
        { court: 1, roundIndex: 1, team1: ['pX', 'pD'], team2: ['pE', 'pF'] },
      ];
      const { rounds, duplicates } = applyNextUpEdits(makeRounds(), edits);
      check('applyNextUpEdits: cross-index same player allowed (no duplicate)', duplicates.length === 0);
      check('applyNextUpEdits: writes into rounds[ni].courts[court]',
        rounds[2].courts[0].team1[0] === 'pX' && rounds[1].courts[1].team1[0] === 'pX');
    }
    // 3. Duplicate within a single edited court is detected.
    {
      const edits = [{ court: 0, roundIndex: 1, team1: ['pX', 'pX'], team2: ['p2', 'p3'] }];
      const { duplicates } = applyNextUpEdits(makeRounds(), edits);
      check('applyNextUpEdits: same player twice in one court detected',
        duplicates.length === 1 && duplicates[0].ids.includes('pX'));
    }
    // 4. Empty ('') slots are never flagged as duplicates.
    {
      const edits = [
        { court: 0, roundIndex: 1, team1: ['', ''], team2: ['p2', 'p3'] },
        { court: 1, roundIndex: 1, team1: ['', ''], team2: ['p6', 'p7'] },
      ];
      const { duplicates } = applyNextUpEdits(makeRounds(), edits);
      check('applyNextUpEdits: empty slots not treated as duplicates', duplicates.length === 0);
    }
    // 5. Purity: input rounds not mutated.
    {
      const input = makeRounds();
      applyNextUpEdits(input, [{ court: 0, roundIndex: 1, team1: ['pZ', 'pZ'], team2: ['p2', 'p3'] }]);
      check('applyNextUpEdits: does not mutate input', input[1].courts[0].team1[0] === 'p8');
    }
    // 6. Defensive: out-of-range / empty / undefined.
    {
      const a = applyNextUpEdits(makeRounds(), [{ court: 0, roundIndex: 99, team1: ['p0', 'p1'], team2: ['p2', 'p3'] }]);
      check('applyNextUpEdits: out-of-range edit ignored, no throw', a.duplicates.length === 0 && a.rounds.length === 3);
      const b = applyNextUpEdits([], []);
      const c = applyNextUpEdits(undefined, undefined);
      check('applyNextUpEdits: empty -> {rounds:[],duplicates:[]}', Array.isArray(b.rounds) && b.duplicates.length === 0);
      check('applyNextUpEdits: undefined -> {rounds:[],duplicates:[]}', Array.isArray(c.rounds) && c.duplicates.length === 0);
    }
    // 7. Editing one court to a player already in a SIBLING (UNEDITED) court of the
    //    same next-round index is flagged (round 1 court1 unedited holds p12).
    {
      const edits = [{ court: 0, roundIndex: 1, team1: ['p12', 'pY'], team2: ['pZ', 'pW'] }];
      const { duplicates } = applyNextUpEdits(makeRounds(), edits);
      const d = duplicates.find(x => x.roundIndex === 1);
      check('applyNextUpEdits: collision with unedited sibling court flagged', !!d && d.ids.includes('p12'));
    }
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-next-up — Up Next feature logic\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  computeNextUp computes per-court next-round rows');
  console.log('  PASS  nextCourtRounds advances each court +1 (clamped, offsets kept)');
  console.log('  PASS  applyNextUpEdits applies edits + per-index duplicate detection');
  console.log('\nRESULT: PASS — all Up Next assertions green.');
  process.exit(0);
}
