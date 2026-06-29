#!/usr/bin/env node
/*
 * test-court-edit.js — behavioural guard for the manual round/court editor.
 *
 * Reproduces and locks down the "names jump to Thomas on save" bug reported on
 * a slower (M1) MacBook. Two compounding defects:
 *
 *   1. A <select> whose value matches no <option> defaults to its FIRST option.
 *      Court slots store player IDs; an empty ('') slot or an id that is no
 *      longer in state.players therefore rendered (and saved) as the first
 *      roster player — "Thomas" (p0). The fix: a pure helper
 *      playerSelectOptions(players, selectedId, escFn) that always emits a
 *      leading "— empty —" option which is selected whenever selectedId is
 *      falsy OR matches no current player, so an unknown/empty slot resolves to
 *      '' (empty), never silently to the first player.
 *
 *   2. The 2s poll rebuilt the round editor (renderRoundList) whenever no form
 *      control was focused, discarding an in-progress manual arrangement. The
 *      fix: shouldHoldAdminRender(adminOpen, editing, expandedRound) — poll must
 *      hold (skip the state overwrite + re-render) while a round editor is open
 *      (expandedRound !== null), not only while a field is focused. The wider
 *      edit window on a slow machine is exactly what let a poll tick land mid-edit.
 *
 * Both helpers are PURE and extracted from public/index.html. Exit 0 = green.
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
const countSelected = (s) => (s.match(/ selected/g) || []).length;

// ── playerSelectOptions ───────────────────────────────────────────
{
  const playerSelectOptions = load('playerSelectOptions');
  if (!playerSelectOptions) {
    failures.push('playerSelectOptions is not defined in public/index.html');
  } else {
    const players = [
      { id: 'p0', name: 'Thomas' },
      { id: 'p1', name: 'Desmond' },
      { id: 'p2', name: 'Celine' },
    ];
    const ident = (s) => s;

    // 1. A known id selects exactly that player; the empty option is NOT selected.
    {
      const out = playerSelectOptions(players, 'p1', ident);
      check('playerSelectOptions: known id selects that player',
        /<option value="p1" selected>Desmond<\/option>/.test(out));
      check('playerSelectOptions: known id -> exactly one selected', countSelected(out) === 1);
      check('playerSelectOptions: known id does not select empty option',
        !/<option value="" selected>/.test(out));
    }

    // 2. THE BUG: an empty slot must select the empty option, never the first player.
    {
      const out = playerSelectOptions(players, '', ident);
      check('playerSelectOptions: empty id selects the empty option',
        /<option value="" selected>/.test(out));
      check('playerSelectOptions: empty id -> exactly one selected', countSelected(out) === 1);
      check('playerSelectOptions: empty id does NOT select Thomas (p0)',
        !/<option value="p0" selected>/.test(out));
    }

    // 3. THE BUG (removed player): an id no longer in players must NOT fall back
    //    to the first player — it resolves to the empty option.
    {
      const out = playerSelectOptions(players, 'pGONE', ident);
      check('playerSelectOptions: unknown id selects the empty option',
        /<option value="" selected>/.test(out));
      check('playerSelectOptions: unknown id -> exactly one selected', countSelected(out) === 1);
      check('playerSelectOptions: unknown id does NOT select first player',
        !/<option value="p0" selected>/.test(out));
    }

    // 4. The escape function is applied to names.
    {
      const out = playerSelectOptions(players, 'p0', (s) => '[' + s + ']');
      check('playerSelectOptions: applies escFn to names', out.includes('[Thomas]'));
    }

    // 5. Defensive: missing/empty player list -> just the empty option, no throw.
    {
      const out = playerSelectOptions(undefined, 'p0', ident);
      check('playerSelectOptions: undefined players -> empty option only',
        /<option value="" selected>/.test(out) && countSelected(out) === 1);
    }

    // 6. Purity: input array not mutated.
    {
      const input = [{ id: 'p0', name: 'Thomas' }];
      playerSelectOptions(input, '', ident);
      check('playerSelectOptions: does not mutate input', input.length === 1 && input[0].id === 'p0');
    }
  }
}

// ── shouldHoldAdminRender ──────────────────────────────────────────
{
  const shouldHoldAdminRender = load('shouldHoldAdminRender');
  if (!shouldHoldAdminRender) {
    failures.push('shouldHoldAdminRender is not defined in public/index.html');
  } else {
    // Viewer device (admin panel not open) must NEVER hold — the live screen
    // has to keep polling regardless of focus/expansion state.
    check('shouldHoldAdminRender: viewer never holds (no admin)',
      shouldHoldAdminRender(false, false, null) === false);
    check('shouldHoldAdminRender: viewer never holds even if expanded flag set',
      shouldHoldAdminRender(false, true, 3) === false);

    // Admin open, idle (no field focused, no round expanded) -> poll proceeds.
    check('shouldHoldAdminRender: admin idle -> does not hold',
      shouldHoldAdminRender(true, false, null) === false);

    // Admin open + a field focused -> hold (existing B1 behaviour preserved).
    check('shouldHoldAdminRender: focused field -> holds',
      shouldHoldAdminRender(true, true, null) === true);

    // THE FIX: admin open + a round editor expanded (even with nothing focused)
    // -> hold, so a poll tick can't wipe the in-progress manual arrangement.
    check('shouldHoldAdminRender: round 0 expanded -> holds',
      shouldHoldAdminRender(true, false, 0) === true);
    check('shouldHoldAdminRender: round 2 expanded -> holds',
      shouldHoldAdminRender(true, false, 2) === true);
  }
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-court-edit — manual round editor (no jump-to-Thomas)\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  playerSelectOptions: empty/unknown slot resolves to "" (never the first player)');
  console.log('  PASS  shouldHoldAdminRender: poll holds while a round editor is open');
  console.log('\nRESULT: PASS — court-editor assertions green.');
  process.exit(0);
}
