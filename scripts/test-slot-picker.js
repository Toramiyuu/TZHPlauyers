#!/usr/bin/env node
/*
 * test-slot-picker.js — behavioural guard for the Friendly board's slot picker.
 *
 * Friendly court slots now open the same searchable picker popover the round /
 * Up Next editors use (openFriendlySlotPicker → openPslotAt), instead of the
 * old tap-to-arm/tap-to-clear behaviour. The picker must:
 *   - list only that side's squad, session-filtered (bench first, then players
 *     already on a court with a "Court N" badge),
 *   - route the pick through pop._onPick (placeFriendlyPlayer keeps a player on
 *     at most one court; empty pick clears the slot),
 *   - short-circuit pickPslot BEFORE the round-editor validation, which would
 *     reject squad ids that aren't in state.players,
 *   - be closed by a friendly board re-render (orphaned anchor node otherwise).
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

// ── openFriendlySlotPicker: functional run with stubbed collaborators ──
{
  const pickerSrc = extractFn('openFriendlySlotPicker', html);
  const placeSrc = extractFn('placeFriendlyPlayer', html);
  if (!pickerSrc || !placeSrc) {
    failures.push('openFriendlySlotPicker / placeFriendlyPlayer are not defined in public/index.html');
  } else {
    const f = {
      redTeam: ['r1', 'r2', 'r3'],
      blueTeam: ['b1', 'b2'],
      matchups: [
        { court: 5, red: ['r1', ''], blue: ['b1', 'b2'] },
        { court: 6, red: ['r3', ''], blue: ['', ''] },
      ],
    };
    const ensureFriendly = () => f;
    // eslint-disable-next-line no-new-func
    const placeFriendlyPlayer = new Function('ensureFriendly',
      `${placeSrc}; return placeFriendlyPlayer;`)(ensureFriendly);
    const captured = {};
    // eslint-disable-next-line no-new-func
    const openFriendlySlotPicker = new Function(
      'ensureFriendly', 'friendlySessionSet', 'playerById', 'frNameOf',
      'buildMetaById', 'openPslotAt', 'placeFriendlyPlayer',
      'renderFriendlyMatchups', 'saveFriendly', '__frSel',
      `${pickerSrc}; return openFriendlySlotPicker;`)(
      ensureFriendly,
      () => new Set(['r1', 'r2', 'r3', 'b1', 'b2']),
      id => ({ id, name: 'N' + id }),
      id => 'N' + id,
      () => ({ r1: { level: 3 } }),
      (el, groups, total, onPick) => Object.assign(captured, { groups, total, onPick }),
      placeFriendlyPlayer,
      () => {}, () => {}, { pid: null });

    // 1. Opening red slot (0,1): bench = r2; r1/r3 badged with their courts.
    openFriendlySlotPicker({}, 0, 'red', 1);
    check('picker lists only that side\'s squad (total = red squad size)',
      captured.total === 3);
    check('bench group holds the unplaced squad player',
      captured.groups && captured.groups.free.length === 1 && captured.groups.free[0].p.id === 'r2');
    check('placed squad players carry a Court N badge',
      JSON.stringify((captured.groups.onCourt || []).map(x => [x.p.id, x.badge]))
        === JSON.stringify([['r1', 'Court 5'], ['r3', 'Court 6']]));
    check('picker relabels groups for the friendly board',
      captured.groups.labels && captured.groups.labels.free === 'On the bench');

    // 2. Picking a player already on another court moves them here.
    captured.onPick('r3');
    check('picking a placed player moves them into this slot',
      JSON.stringify(f.matchups[0].red) === JSON.stringify(['r1', 'r3']));
    check('...and pulls them off their old court',
      JSON.stringify(f.matchups[1].red) === JSON.stringify(['', '']));

    // 3. The empty pick clears the slot.
    openFriendlySlotPicker({}, 0, 'red', 1);
    captured.onPick('');
    check('empty pick clears the slot',
      f.matchups[0].red[1] === '');

    // 4. The slot's current occupant shows as selected (checkmark row), not as
    //    "on a court" — their own slot is excluded from the placed scan.
    openFriendlySlotPicker({}, 0, 'blue', 0);
    check('current occupant is the selected row in the bench group',
      captured.groups.selectedId === 'b1'
      && captured.groups.free.some(x => x.p.id === 'b1')
      && !(captured.groups.onCourt || []).some(x => x.p.id === 'b1'));
  }
}

// ── frSlotTap: picker replaced tap-to-clear / tap-to-arm ───────────
{
  const tapSrc = extractFn('frSlotTap', html) || '';
  check('frSlotTap opens the picker popover',
    tapSrc.includes('openFriendlySlotPicker'));
  check('frSlotTap no longer clears a filled slot on tap (the x / empty pick do)',
    !tapSrc.includes("m[team][k] = ''"));
  check('frSlotTap still places an armed bench player first',
    tapSrc.includes('__frSel.pid') && tapSrc.includes('placeFriendlyPlayer'));
  check('slot markup passes the tapped element to frSlotTap',
    html.includes('onclick="frSlotTap(${i},\'${team}\',${k},this)"'));
}

// ── shared popover plumbing ────────────────────────────────────────
{
  const pickSrc = extractFn('pickPslot', html) || '';
  check('pickPslot routes through _onPick when set',
    pickSrc.includes('_onPick'));
  check('pickPslot checks _onPick BEFORE the state.players validation',
    pickSrc.indexOf('_onPick') > -1 && pickSrc.indexOf('_onPick') < pickSrc.indexOf('state.players'));
  const closeSrc = extractFn('closePlayerPicker', html) || '';
  check('closePlayerPicker clears the custom commit callback',
    closeSrc.includes('_onPick = null'));
  const openSrc = extractFn('openPlayerPicker', html) || '';
  check('round/Up Next editors go through the shared openPslotAt',
    openSrc.includes('openPslotAt('));
  const renderSrc = extractFn('renderFriendlyMatchups', html) || '';
  check('a friendly board re-render closes an open slot picker (orphaned anchor)',
    renderSrc.includes('closePlayerPicker'));
  check('an anchored friendly slot gets the active highlight',
    /\.frb-slot\.pslot-active/.test(html));
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-slot-picker — friendly court slots use the player picker popover\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  openFriendlySlotPicker: squad-only groups, court badges, move/clear commits');
  console.log('  PASS  frSlotTap opens the picker; armed bench taps still place directly');
  console.log('  PASS  shared popover: _onPick routing, cleanup, re-render close');
  console.log('\nRESULT: PASS — friendly slot picker assertions green.');
  process.exit(0);
}
