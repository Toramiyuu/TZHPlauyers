#!/usr/bin/env node
/*
 * test-court-numbers.js — behavioural guard for "select which courts are active".
 *
 * Admins can pick WHICH physical courts a session runs on (e.g. just courts 3 &
 * 4), not only how many. Internally the courts stay slots 0..numCourts-1 exactly
 * as before; state.courtNumbers is a parallel list that only changes the DISPLAY
 * label of each slot. Two pure helpers in public/index.html hold that mapping:
 *
 *   normalizeCourtNumbers(courtNumbers, numCourts)
 *     -> number[] of length numCourts; each entry is the real court number for
 *        that slot, falling back to slot+1 for any missing/invalid value (so
 *        pre-feature state that has only numCourts keeps "Court 1..N").
 *
 *   courtLabel(i)   (reads the module `state`)
 *     -> the display number for slot i — an O(1) mirror of the helper above.
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

// courtLabel reads the module-level `state`; inject one via a wrapper param so
// the extracted function closes over it.
function loadWithState(name, stateObj) {
  const fnSrc = extractFn(name, html);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function('state', `${fnSrc}; return ${name};`)(stateObj);
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const eq = (name, got, want) => check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));

// ── normalizeCourtNumbers ─────────────────────────────────────────
{
  const norm = load('normalizeCourtNumbers');
  if (!norm) {
    failures.push('normalizeCourtNumbers is not defined in public/index.html');
  } else {
    // 1. Explicit selection is returned as-is (courts 3 & 4).
    eq('normalizeCourtNumbers: explicit selection kept', norm([3, 4], 2), [3, 4]);
    // 2. Non-contiguous selection kept in given order.
    eq('normalizeCourtNumbers: non-contiguous kept', norm([2, 5, 8], 3), [2, 5, 8]);
    // 3. Missing array -> default 1..numCourts (pre-feature state).
    eq('normalizeCourtNumbers: undefined -> 1..N default', norm(undefined, 3), [1, 2, 3]);
    // 4. Short array -> only the missing slots fall back to slot+1.
    eq('normalizeCourtNumbers: short array padded per-slot', norm([5], 3), [5, 2, 3]);
    // 5. Invalid entries (0, negative, NaN, non-number) fall back to slot+1.
    eq('normalizeCourtNumbers: invalid entries fall back', norm([0, -1, 'x'], 3), [1, 2, 3]);
    // 6. Longer array is truncated to numCourts.
    eq('normalizeCourtNumbers: truncates to numCourts', norm([3, 4, 5, 6], 2), [3, 4]);
    // 7. Floats are floored.
    eq('normalizeCourtNumbers: floats floored', norm([3.9], 1), [3]);
    // 8. numCourts 0 / missing -> [].
    eq('normalizeCourtNumbers: zero courts -> []', norm([3, 4], 0), []);
    eq('normalizeCourtNumbers: undefined numCourts -> []', norm([3, 4]), []);
    // 9. Purity: input array not mutated.
    {
      const input = [3, 4];
      norm(input, 2);
      eq('normalizeCourtNumbers: does not mutate input', input, [3, 4]);
    }
  }
}

// ── courtLabel ────────────────────────────────────────────────────
{
  // Active courts 3 & 4.
  const labelSel = loadWithState('courtLabel', { numCourts: 2, courtNumbers: [3, 4] });
  if (!labelSel) {
    failures.push('courtLabel is not defined in public/index.html');
  } else {
    check('courtLabel: slot 0 -> court 3', labelSel(0) === 3);
    check('courtLabel: slot 1 -> court 4', labelSel(1) === 4);
    // No courtNumbers -> slot+1 (legacy behaviour).
    const labelLegacy = loadWithState('courtLabel', { numCourts: 2 });
    check('courtLabel: legacy state -> slot+1', labelLegacy(0) === 1 && labelLegacy(1) === 2);
    // Invalid entry at slot -> slot+1 fallback.
    const labelBad = loadWithState('courtLabel', { numCourts: 2, courtNumbers: [0, 4] });
    check('courtLabel: invalid entry falls back to slot+1', labelBad(0) === 1 && labelBad(1) === 4);
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-court-numbers — active-court selection labels\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  normalizeCourtNumbers maps slots to real court numbers (with fallbacks)');
  console.log('  PASS  courtLabel returns the display number for a slot');
  console.log('\nRESULT: PASS — all active-court assertions green.');
  process.exit(0);
}
