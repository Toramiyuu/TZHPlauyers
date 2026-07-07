#!/usr/bin/env node
/*
 * test-ending-soon.js — behavioural guard for the "Ending Soon" feature.
 *
 * The admin can flag individual courts as "ending soon" so resting players
 * know which court is about to free up. The viewer shows an amber pill on that
 * court's card. A flag auto-clears when its court advances to a fresh game.
 * The non-DOM logic lives in three PURE helpers inside public/index.html:
 *
 *   normalizeEndingSoon(endingSoon, numCourts)
 *     -> a NEW boolean[] of length numCourts, coercing each entry to bool and
 *        padding/truncating to numCourts (tolerant of undefined/garbage input).
 *
 *   setEndingSoon(endingSoon, courtIdx, numCourts, value)
 *     -> a NEW normalized boolean[] with court `courtIdx` set to `value`, or
 *        TOGGLED when `value` is undefined. Out-of-range courtIdx is a no-op.
 *
 *   clearEndingSoonForCourt(endingSoon, courtIdx, numCourts)
 *     -> a NEW normalized boolean[] with court `courtIdx` cleared, or null when
 *        there was nothing set to clear (so callers can skip a needless write).
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
  // Helpers reference each other (setEndingSoon/clearEndingSoonForCourt call
  // normalizeEndingSoon), so pull normalizeEndingSoon into the eval scope too.
  const dep = extractFn('normalizeEndingSoon', html) || '';
  const body = name === 'normalizeEndingSoon' ? fnSrc : `${dep}; ${fnSrc}`;
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return ${name};`)();
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// ── normalizeEndingSoon ───────────────────────────────────────────
{
  const normalizeEndingSoon = load('normalizeEndingSoon');
  if (!normalizeEndingSoon) {
    failures.push('normalizeEndingSoon is not defined in public/index.html');
  } else {
    // 1. Pads to numCourts with false.
    {
      const a = normalizeEndingSoon([true], 3);
      check('normalizeEndingSoon: pads to numCourts', a.length === 3 && a[0] === true && a[1] === false && a[2] === false);
    }
    // 2. Truncates to numCourts.
    {
      const a = normalizeEndingSoon([true, false, true, true], 2);
      check('normalizeEndingSoon: truncates to numCourts', a.length === 2 && a[0] === true && a[1] === false);
    }
    // 3. Coerces every entry to a real boolean.
    {
      const a = normalizeEndingSoon([1, 0, 'x', null, undefined], 5);
      check('normalizeEndingSoon: coerces to booleans',
        a.every(v => typeof v === 'boolean') && a[0] === true && a[1] === false && a[2] === true && a[3] === false && a[4] === false);
    }
    // 4. Tolerant of undefined / non-array input.
    {
      const a = normalizeEndingSoon(undefined, 2);
      const b = normalizeEndingSoon('garbage', 2);
      check('normalizeEndingSoon: undefined -> all false', a.length === 2 && a[0] === false && a[1] === false);
      check('normalizeEndingSoon: non-array -> all false', b.length === 2 && b[0] === false && b[1] === false);
    }
    // 5. numCourts 0 / missing -> empty array, no throw.
    {
      const a = normalizeEndingSoon([true, true], 0);
      const b = normalizeEndingSoon([true], undefined);
      check('normalizeEndingSoon: zero courts -> []', Array.isArray(a) && a.length === 0);
      check('normalizeEndingSoon: missing numCourts -> []', Array.isArray(b) && b.length === 0);
    }
  }
}

// ── setEndingSoon ─────────────────────────────────────────────────
{
  const setEndingSoon = load('setEndingSoon');
  if (!setEndingSoon) {
    failures.push('setEndingSoon is not defined in public/index.html');
  } else {
    // 1. Explicit set true / false.
    {
      const a = setEndingSoon([false, false], 1, 2, true);
      check('setEndingSoon: sets value true', a[0] === false && a[1] === true);
      const b = setEndingSoon([true, true], 0, 2, false);
      check('setEndingSoon: sets value false', b[0] === false && b[1] === true);
    }
    // 2. Toggle when value omitted.
    {
      const a = setEndingSoon([false, false], 0, 2);
      check('setEndingSoon: toggles off->on', a[0] === true && a[1] === false);
      const b = setEndingSoon(a, 0, 2);
      check('setEndingSoon: toggles on->off', b[0] === false);
    }
    // 3. Out-of-range courtIdx is a no-op (still returns a normalized array).
    {
      const a = setEndingSoon([false, false], 5, 2, true);
      check('setEndingSoon: out-of-range high -> no change', a.length === 2 && a[0] === false && a[1] === false);
      const b = setEndingSoon([false, false], -1, 2);
      check('setEndingSoon: out-of-range low -> no change', b.length === 2 && b[0] === false && b[1] === false);
    }
    // 4. Purity: does not mutate the input array.
    {
      const input = [false, false];
      setEndingSoon(input, 0, 2, true);
      check('setEndingSoon: does not mutate input', input[0] === false);
    }
    // 5. Grows the array if numCourts increased since the flags were stored.
    {
      const a = setEndingSoon([true], 2, 3, true);
      check('setEndingSoon: grows to numCourts and sets new index', a.length === 3 && a[0] === true && a[1] === false && a[2] === true);
    }
  }
}

// ── clearEndingSoonForCourt ───────────────────────────────────────
{
  const clearEndingSoonForCourt = load('clearEndingSoonForCourt');
  if (!clearEndingSoonForCourt) {
    failures.push('clearEndingSoonForCourt is not defined in public/index.html');
  } else {
    // 1. Clears a set flag and returns a new normalized array.
    {
      const a = clearEndingSoonForCourt([true, true], 0, 2);
      check('clearEndingSoonForCourt: clears set flag', a && a[0] === false && a[1] === true);
    }
    // 2. Returns null when there was nothing to clear (skip needless write).
    {
      const a = clearEndingSoonForCourt([false, true], 0, 2);
      check('clearEndingSoonForCourt: null when already clear', a === null);
      const b = clearEndingSoonForCourt(undefined, 0, 2);
      check('clearEndingSoonForCourt: null on undefined input', b === null);
    }
    // 3. Out-of-range courtIdx -> null, no throw.
    {
      const a = clearEndingSoonForCourt([true, true], 9, 2);
      check('clearEndingSoonForCourt: out-of-range -> null', a === null);
    }
    // 4. Purity: does not mutate the input array.
    {
      const input = [true, true];
      clearEndingSoonForCourt(input, 0, 2);
      check('clearEndingSoonForCourt: does not mutate input', input[0] === true);
    }
  }
}

// ── clearEndingSoonForChangedCourts ───────────────────────────────
{
  const clearEndingSoonForChangedCourts = load('clearEndingSoonForChangedCourts');
  if (!clearEndingSoonForChangedCourts) {
    failures.push('clearEndingSoonForChangedCourts is not defined in public/index.html');
  } else {
    // 1. Clears flags only for courts whose round index changed.
    {
      const a = clearEndingSoonForChangedCourts([true, true], [7, 7], [8, 7], 2);
      check('clearEndingSoonForChangedCourts: clears only changed courts', a && a[0] === false && a[1] === true);
    }
    // 2. All courts moved (round 8 -> 9 for everyone) -> all flags cleared.
    {
      const a = clearEndingSoonForChangedCourts([true, true], [7, 7], [8, 8], 2);
      check('clearEndingSoonForChangedCourts: clears all moved courts', a && a[0] === false && a[1] === false);
    }
    // 3. Null when no flagged court changed (skip needless write).
    {
      const a = clearEndingSoonForChangedCourts([true, false], [5, 5], [5, 6], 2);
      check('clearEndingSoonForChangedCourts: null when flagged court unchanged', a === null);
      const b = clearEndingSoonForChangedCourts([false, false], [1, 1], [2, 2], 2);
      check('clearEndingSoonForChangedCourts: null when nothing flagged', b === null);
      const c = clearEndingSoonForChangedCourts(undefined, [1], [2], 1);
      check('clearEndingSoonForChangedCourts: null on undefined flags', c === null);
    }
    // 4. Missing round entries are treated as 0.
    {
      const a = clearEndingSoonForChangedCourts([true], undefined, [1], 1);
      check('clearEndingSoonForChangedCourts: missing prev treated as 0', a && a[0] === false);
      const b = clearEndingSoonForChangedCourts([true], [0], undefined, 1);
      check('clearEndingSoonForChangedCourts: missing next treated as 0 -> null', b === null);
    }
    // 5. Purity: does not mutate the input array.
    {
      const input = [true, true];
      clearEndingSoonForChangedCourts(input, [0, 0], [1, 1], 2);
      check('clearEndingSoonForChangedCourts: does not mutate input', input[0] === true);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-ending-soon — Ending Soon feature logic\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  normalizeEndingSoon coerces/pads/truncates to numCourts booleans');
  console.log('  PASS  setEndingSoon sets or toggles a court flag (pure, range-safe)');
  console.log('  PASS  clearEndingSoonForCourt clears on advance or returns null');
  console.log('  PASS  clearEndingSoonForChangedCourts clears flags of courts whose round changed');
  console.log('\nRESULT: PASS — all Ending Soon assertions green.');
  process.exit(0);
}
