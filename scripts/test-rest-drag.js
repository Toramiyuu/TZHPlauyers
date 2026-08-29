#!/usr/bin/env node
/*
 * test-rest-drag.js — behavioural guard for the movable "Resting this round"
 * strip.
 *
 * The sticky strip can pin itself over whatever the admin is editing, so it
 * can now be picked up (mouse: anywhere on the strip; touch: the grip, whose
 * touch-action:none stops page scrolling) and parked anywhere — the position
 * persists in localStorage (REST_POS_KEY) and double-click docks it back.
 *
 * Invariants:
 *   - applyRestFloat() clamps the saved position inside the viewport, docks
 *     cleanly when no position is saved, and never fights a live drag,
 *   - float classes/position live on the persistent #restingStrip host, so a
 *     poll re-render of the chips inside can't knock the strip loose,
 *   - syncRestSticky() defers to the float entirely (no pin observer while
 *     parked), and isEditing() holds the poll during a live drag.
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

// ── applyRestFloat: functional run with a stubbed host/viewport ────
{
  const src = extractFn('applyRestFloat', html);
  if (!src) {
    failures.push('applyRestFloat is not defined in public/index.html');
  } else {
    const makeHost = () => {
      const cls = new Set();
      return {
        firstElementChild: {},
        style: {},
        offsetWidth: 320,
        offsetHeight: 44,
        classList: {
          add: (...a) => a.forEach(c => cls.add(c)),
          remove: (...a) => a.forEach(c => cls.delete(c)),
          contains: c => cls.has(c),
        },
      };
    };
    const run = (host, stored, restDrag) => {
      const doc = { getElementById: id => (id === 'restingStrip' ? host : null) };
      const win = { innerWidth: 800, innerHeight: 600 };
      const ls = { getItem: k => (k in stored ? stored[k] : null) };
      // eslint-disable-next-line no-new-func
      return new Function('document', 'window', 'localStorage', '__restDrag', 'REST_POS_KEY',
        `${src}; return applyRestFloat();`)(doc, win, ls, restDrag || null, 'restStripPos');
    };

    // 1. Saved position applies as fixed float.
    {
      const host = makeHost();
      const out = run(host, { restStripPos: JSON.stringify({ x: 100, y: 200 }) });
      check('saved position floats the strip at that spot',
        out === true && host.classList.contains('rest-floating')
        && host.style.left === '100px' && host.style.top === '200px');
    }
    // 2. Off-screen positions clamp back inside the viewport.
    {
      const host = makeHost();
      run(host, { restStripPos: JSON.stringify({ x: 9999, y: -50 }) });
      check('off-screen park clamps inside the viewport',
        host.style.left === '476px' && host.style.top === '4px'); // 800-320-4, floor 4
    }
    // 3. No saved position → docked: class off, inline position cleared.
    {
      const host = makeHost();
      host.classList.add('rest-floating');
      host.style.left = '10px'; host.style.top = '10px';
      const out = run(host, {});
      check('no saved position docks the strip back into sticky flow',
        out === false && !host.classList.contains('rest-floating')
        && host.style.left === '' && host.style.top === '');
    }
    // 4. Garbage in localStorage must not throw — falls back to docked.
    {
      const host = makeHost();
      let out = null, threw = false;
      try { out = run(host, { restStripPos: '{not json' }); } catch (_) { threw = true; }
      check('corrupt saved position falls back to docked (no throw)',
        !threw && out === false);
    }
    // 5. A live drag owns the position — re-applying must not snap it back.
    {
      const host = makeHost();
      host.style.left = '55px'; host.style.top = '66px';
      const out = run(host, { restStripPos: JSON.stringify({ x: 1, y: 1 }) }, { moved: true });
      check('a live drag is never overridden by the saved position',
        out === true && host.style.left === '55px' && host.style.top === '66px');
    }
  }
}

// ── markup + wiring ────────────────────────────────────────────────
{
  const renderSrc = extractFn('renderRestingPlayers', html) || '';
  check('strip renders a drag grip', renderSrc.includes('rest-grip'));
  check('strip wires the drag handlers after render', renderSrc.includes('initRestStripDrag'));
  check('grip blocks touch scrolling so touch drags work',
    /\.rest-grip\{[^}]*touch-action:none/.test(html));
  check('floating strip is fixed-position on the persistent host',
    /#restingStrip\.rest-floating\{[^}]*position:fixed/.test(html));
  const syncSrc = extractFn('syncRestSticky', html) || '';
  check('syncRestSticky defers to the float (no pin observer while parked)',
    syncSrc.includes('applyRestFloat'));
  const dragSrc = extractFn('initRestStripDrag', html) || '';
  check('double-click docks the strip back (clears the saved position)',
    dragSrc.includes('dblclick') && dragSrc.includes('removeItem'));
  check('a plain click never counts as a drag (dead zone before floating)',
    dragSrc.includes('Math.hypot'));
}

// ── poll race: isEditing() must hold while a strip drag is live ────
{
  const isEditingSrc = extractFn('isEditing', html) || '';
  check('isEditing() guards against re-render during a strip drag',
    isEditingSrc.includes('__restDrag'));
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-rest-drag — movable "Resting this round" strip\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  applyRestFloat: parks, clamps, docks, survives garbage, respects live drags');
  console.log('  PASS  grip + fixed-float wiring on the persistent host');
  console.log('  PASS  isEditing() holds the poll during a live drag');
  console.log('\nRESULT: PASS — resting strip drag assertions green.');
  process.exit(0);
}
