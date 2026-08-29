#!/usr/bin/env node
/*
 * test-score-input.js — behavioural guard for typed Friendly scores.
 *
 * The number between the +/− steppers on the Friendly board is a real
 * <input type="number"> now, so a score can be typed instead of tapped up
 * one press at a time. Invariants:
 *   - typeFriendlyScore commits state on every keystroke, clamped 0–99, so
 *     "Record result & reset" always reads the on-screen number,
 *   - the network save is debounced while typing and forced on blur,
 *   - an emptied field is mid-edit: no commit, blur restores the real score,
 *   - stepFriendlyScore writes input .value (textContent is invisible on an
 *     input — steppers would silently stop updating the display).
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

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// ── typeFriendlyScore / blurFriendlyScore: functional runs ─────────
{
  const typeSrc = extractFn('typeFriendlyScore', html);
  const blurSrc = extractFn('blurFriendlyScore', html);
  if (!typeSrc || !blurSrc) {
    failures.push('typeFriendlyScore / blurFriendlyScore are not defined in public/index.html');
  } else {
    const build = (m, log) => {
      const ensureFriendly = () => ({ matchups: [m] });
      const saveFriendly = () => log.push('save');
      const setTimeoutStub = (fn, ms) => { log.push('debounce:' + ms); return 1; };
      // eslint-disable-next-line no-new-func
      return new Function(
        'ensureFriendly', 'saveFriendly', 'setTimeout', 'clearTimeout', '__frScoreSaveT',
        `${typeSrc}; ${blurSrc}; return { typeFriendlyScore, blurFriendlyScore };`)(
        ensureFriendly, saveFriendly, setTimeoutStub, () => {}, null);
    };

    // 1. Typing commits the value to state immediately (debounced save).
    {
      const m = { redScore: 3, blueScore: 0 };
      const log = [];
      build(m, log).typeFriendlyScore(0, 'redScore', { value: '17' });
      check('typed score commits to state on keystroke',
        m.redScore === 17);
      check('typed score debounces the network save',
        log.includes('debounce:400') && !log.includes('save'));
    }
    // 2. Out-of-range / junk input clamps into 0–99 and normalises the field.
    {
      const m = { redScore: 0, blueScore: 0 };
      const el = { value: '555' };
      build(m, []).typeFriendlyScore(0, 'redScore', el);
      check('over-99 clamps to 99', m.redScore === 99 && el.value === 99);
      const el2 = { value: '-4' };
      build(m, []).typeFriendlyScore(0, 'blueScore', el2);
      check('negative clamps to 0', m.blueScore === 0 && el2.value === 0);
    }
    // 3. An emptied field is mid-edit: nothing commits, nothing saves.
    {
      const m = { redScore: 8, blueScore: 0 };
      const log = [];
      build(m, log).typeFriendlyScore(0, 'redScore', { value: '' });
      check('emptied field does not commit or save',
        m.redScore === 8 && log.length === 0);
    }
    // 4. Blur on an emptied field restores the real score (no accidental 0).
    {
      const m = { redScore: 8, blueScore: 0 };
      const el = { value: '' };
      const log = [];
      build(m, log).blurFriendlyScore(0, 'redScore', el);
      check('blur restores the real score into an emptied field',
        el.value === 8 && m.redScore === 8 && !log.includes('save'));
    }
    // 5. Blur with a value commits AND forces the save (no debounce left).
    {
      const m = { redScore: 1, blueScore: 0 };
      const log = [];
      build(m, log).blurFriendlyScore(0, 'redScore', { value: '21' });
      check('blur commits the typed score and saves immediately',
        m.redScore === 21 && log.includes('save'));
    }
  }
}

// ── stepFriendlyScore must drive the input's .value ────────────────
{
  const stepSrc = extractFn('stepFriendlyScore', html);
  if (!stepSrc) {
    failures.push('stepFriendlyScore is not defined in public/index.html');
  } else {
    const m = { redScore: 5, blueScore: 0 };
    const n = { value: '5', textContent: '' };
    const btn = { parentElement: { querySelector: sel => (sel === '.n' ? n : null) } };
    // eslint-disable-next-line no-new-func
    new Function('ensureFriendly', 'saveFriendly',
      `${stepSrc}; stepFriendlyScore(0,'redScore',1,arguments[2]);`)(
      () => ({ matchups: [m] }), () => {}, btn);
    check('stepper writes input .value (textContent is invisible on an input)',
      m.redScore === 6 && n.value === 6 && n.textContent === '');
  }
}

// ── markup ─────────────────────────────────────────────────────────
{
  check('score is an <input type="number"> between the steppers',
    html.includes(`<input class="n" type="number" inputmode="numeric" min="0" max="99"`));
  check('focus selects the current number for quick overwrite',
    html.includes(`onfocus="this.select()"`));
  check('Enter commits (blurs) the typed score',
    html.includes(`onkeydown="if(event.key==='Enter')this.blur()"`));
  check('webkit spinners are hidden so the control keeps its look',
    html.includes('.frb-score input.n::-webkit-outer-spin-button'));
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-score-input — typed Friendly scores\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  typeFriendlyScore: commits per keystroke, clamps 0–99, debounces saves');
  console.log('  PASS  blurFriendlyScore: restores emptied fields, forces the save');
  console.log('  PASS  stepFriendlyScore drives the input; markup wired for typing');
  console.log('\nRESULT: PASS — typed score assertions green.');
  process.exit(0);
}
