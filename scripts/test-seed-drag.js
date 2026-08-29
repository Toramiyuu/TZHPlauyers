#!/usr/bin/env node
/*
 * test-seed-drag.js — behavioural guard for drag-to-reorder seed lists
 * (Friendly Red vs Blue squads panel).
 *
 * The ▲/▼ seed buttons were replaced by a pointer drag: the whole row drags
 * with a mouse, touch drags start on the grip (touch-action:none), and the
 * grip keeps ArrowUp/ArrowDown for keyboard users. On release the DOM order
 * commits through applyFriendlySeedOrder(arr, orderedShownIds), which must
 * reorder ONLY the shown (session) players while hidden (non-session) players
 * keep their array slots — same invariant the old swap-based moveFriendlySeed
 * preserved.
 *
 * Also locks down the poll race: isEditing() must report true while a seed
 * drag is live (__frSeedDrag), otherwise a 2s poll tick re-renders the squad
 * list and destroys the DOM node being dragged mid-gesture.
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

// ── applyFriendlySeedOrder ─────────────────────────────────────────
{
  const applyFriendlySeedOrder = load('applyFriendlySeedOrder');
  if (!applyFriendlySeedOrder) {
    failures.push('applyFriendlySeedOrder is not defined in public/index.html');
  } else {
    // 1. All players shown: array becomes exactly the dragged order.
    {
      const out = applyFriendlySeedOrder(['a', 'b', 'c'], ['c', 'a', 'b']);
      check('applyFriendlySeedOrder: full reorder follows dragged order',
        JSON.stringify(out) === JSON.stringify(['c', 'a', 'b']));
    }
    // 2. Hidden (non-session) players keep their array slots; shown players
    //    fill the remaining slots in dragged order.
    {
      const out = applyFriendlySeedOrder(['a', 'hidden1', 'b', 'c', 'hidden2'], ['c', 'b', 'a']);
      check('applyFriendlySeedOrder: hidden players keep their slots',
        JSON.stringify(out) === JSON.stringify(['c', 'hidden1', 'b', 'a', 'hidden2']));
    }
    // 3. No mutation of the input array.
    {
      const arr = ['a', 'b'];
      applyFriendlySeedOrder(arr, ['b', 'a']);
      check('applyFriendlySeedOrder: does not mutate input',
        JSON.stringify(arr) === JSON.stringify(['a', 'b']));
    }
    // 4. Dragging to the same order is a no-op.
    {
      const out = applyFriendlySeedOrder(['a', 'b', 'c'], ['a', 'b', 'c']);
      check('applyFriendlySeedOrder: identical order is a no-op',
        JSON.stringify(out) === JSON.stringify(['a', 'b', 'c']));
    }
  }
}

// ── markup: drag rows replaced the ▲/▼ buttons ─────────────────────
{
  check('seed rows carry data-pid for commit-on-release',
    /fr-seed-row" data-pid="\$\{id\}"/.test(html));
  check('seed rows start a drag on pointerdown',
    html.includes(`onpointerdown="frSeedDragStart(event,'\${side}','\${id}')"`));
  check('grip keeps keyboard reordering (arrow keys)',
    html.includes(`onkeydown="frSeedKey(event,'\${side}','\${id}')"`));
  check('grip blocks touch scrolling so touch drags work',
    /\.fr-seed-grip\{[^}]*touch-action:none/.test(html));
  check('old up/down seed buttons are gone', !html.includes('fr-seed-mv'));
}

// ── poll race: isEditing() must hold while a seed drag is live ─────
{
  const isEditingSrc = extractFn('isEditing', html) || '';
  check('isEditing() guards against re-render during a seed drag',
    isEditingSrc.includes('__frSeedDrag'));
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-seed-drag — drag-to-reorder seed lists\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  applyFriendlySeedOrder: shown players reorder, hidden players keep slots');
  console.log('  PASS  seed rows drag via pointer; grip keeps keyboard access');
  console.log('  PASS  isEditing() holds the poll during a live drag');
  console.log('\nRESULT: PASS — seed drag assertions green.');
  process.exit(0);
}
