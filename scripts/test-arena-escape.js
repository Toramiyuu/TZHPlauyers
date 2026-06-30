#!/usr/bin/env node
/*
 * test-arena-escape.js — guard for the "Escape kicks me out of 3D" bug.
 *
 * BUG this reproduces: the 3D arena is an iframe (public/3d/arena-webgl.html)
 * layered over the 2D viewer. Its nav buttons (Members / Leaderboard / Join)
 * post a message so the host opens those modals ON TOP of the arena — the user
 * stays in 3D. But clicking a nav button moves keyboard focus INTO the iframe,
 * and the iframe had a global `Escape -> exitArena()` handler that fired
 * unconditionally. So pressing Escape to dismiss a just-opened panel dropped the
 * user back to 2D instead of only closing the panel.
 *
 * FIX:
 *   - arena-webgl.html: on Escape, when embedded, FORWARD it to the host as a
 *     `tzh-escape` message instead of calling exitArena() directly.
 *   - index.html: the host's `tzh-escape` branch closes any open overlay first
 *     (closeOpenOverlays) and only leaves 3D (exit3D) when nothing was open.
 *
 * This test:
 *   1. Behaviourally exercises the pure-ish closeOpenOverlays() helper extracted
 *      from index.html with a stub document + stub close fns: an open overlay is
 *      closed and the helper reports true; with nothing open it reports false
 *      (which is the signal the host uses to leave 3D).
 *   2. Statically pins the wiring: the arena forwards Escape as tzh-escape (and
 *      does NOT call exitArena unconditionally on Escape), and the host routes
 *      tzh-escape through closeOpenOverlays before exit3D.
 *
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const ARENA_PATH = path.join(ROOT, 'public', '3d', 'arena-webgl.html');
const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
const arenaHtml = fs.readFileSync(ARENA_PATH, 'utf8');

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

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
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// ── 1. behavioural: closeOpenOverlays() ─────────────────────────────
{
  const fnSrc = extractFn('closeOpenOverlays', indexHtml);
  if (!fnSrc) {
    failures.push('closeOpenOverlays is not defined in public/index.html');
  } else {
    // Build the helper with injected document + close fns so we can observe
    // exactly which overlay it closed without a real DOM.
    const make = () => {
      const calls = [];
      const closers = {
        hidePickerOverlay: () => calls.push('hidePickerOverlay'),
        closeMembersModal: () => calls.push('closeMembersModal'),
        closeLbModal: () => calls.push('closeLbModal'),
        closeMdBoard: () => calls.push('closeMdBoard'),
        closeHistoryModal: () => calls.push('closeHistoryModal'),
        closeJoinModal: () => calls.push('closeJoinModal'),
      };
      // `open` = set of overlay ids considered visible. pickerOverlay uses the
      // `active` class; the modals use `open` — the stub honours both.
      const makeDoc = (open) => ({
        getElementById: (id) => ({
          classList: { contains: (cls) => open.has(id) && (cls === 'open' || cls === 'active') },
        }),
      });
      const argNames = ['document', ...Object.keys(closers)];
      // eslint-disable-next-line no-new-func
      const factory = new Function(...argNames, `${fnSrc}; return closeOpenOverlays;`);
      return { calls, closers, makeDoc, factory };
    };

    // a) members modal open -> closes ONLY it, reports true
    {
      const { calls, closers, makeDoc, factory } = make();
      const fn = factory(makeDoc(new Set(['membersModal'])), ...Object.values(closers));
      const closed = fn();
      check('closeOpenOverlays: reports true when an overlay is open', closed === true);
      check('closeOpenOverlays: closes the open members modal', calls.includes('closeMembersModal'));
      check('closeOpenOverlays: does not touch unrelated overlays', calls.length === 1);
    }

    // b) join modal open -> closes join, reports true
    {
      const { calls, closers, makeDoc, factory } = make();
      const fn = factory(makeDoc(new Set(['joinModal'])), ...Object.values(closers));
      check('closeOpenOverlays: closes the open join modal', fn() === true && calls.includes('closeJoinModal'));
    }

    // c) picker overlay active -> closes it, reports true
    {
      const { calls, closers, makeDoc, factory } = make();
      const fn = factory(makeDoc(new Set(['pickerOverlay'])), ...Object.values(closers));
      check('closeOpenOverlays: closes the active picker overlay', fn() === true && calls.includes('hidePickerOverlay'));
    }

    // d) nothing open -> reports false (host then leaves 3D), closes nothing
    {
      const { calls, closers, makeDoc, factory } = make();
      const fn = factory(makeDoc(new Set()), ...Object.values(closers));
      const closed = fn();
      check('closeOpenOverlays: reports false when no overlay is open', closed === false);
      check('closeOpenOverlays: closes nothing when no overlay is open', calls.length === 0);
    }
  }
}

// ── 2. static wiring: arena forwards Escape; host routes it ─────────
// The arena must forward Escape to the host as tzh-escape...
check('arena-webgl.html: forwards Escape as a tzh-escape message', /tzh-escape/.test(arenaHtml));
// ...and inside the keydown handler, exitArena() must NOT be the direct/
// unconditional response to Escape (the original bug). When embedded the handler
// relays tzh-escape and returns; exitArena() is reached only behind an
// isEmbedded() guard (the standalone fallback). So within the handler block,
// isEmbedded() must appear before exitArena(), and the relay must be present.
{
  const start = arenaHtml.indexOf("addEventListener('keydown'");
  const handler = start === -1 ? '' : arenaHtml.slice(start, start + 400);
  const idxEmbedded = handler.indexOf('isEmbedded(');
  const idxExit = handler.indexOf('exitArena()');
  check('arena-webgl.html: Escape keydown handler relays via postMessage',
    /postMessage/.test(handler) && /tzh-escape/.test(handler));
  check('arena-webgl.html: Escape keydown handler guards exitArena() behind isEmbedded()',
    idxEmbedded !== -1 && idxExit !== -1 && idxEmbedded < idxExit);
}
// The host must handle tzh-escape by closing overlays first, then exit3D.
check('index.html: handles the tzh-escape message', /tzh-escape/.test(indexHtml));
{
  const m = indexHtml.match(/tzh-escape'[\s\S]{0,200}/);
  const branch = m ? m[0] : '';
  check('index.html: tzh-escape closes overlays before leaving 3D',
    /closeOpenOverlays\(\)/.test(branch) && /exit3D\(\)/.test(branch));
}

// ── report ──────────────────────────────────────────────────────────
if (failures.length) {
  console.error('FAIL test-arena-escape:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS test-arena-escape: Escape inside 3D closes panels, only leaves 3D when nothing is open');
process.exit(0);
