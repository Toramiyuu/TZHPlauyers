#!/usr/bin/env node
/*
 * test-court-bench.js — behavioural guard for the Courts-tab bench board.
 *
 * The read-only "Resting this round" strip was replaced by the Friendly-board
 * interaction model: a sticky bench side panel (reusing .frb-bench / .frb-chip
 * / .frb-side) next to editable court cards. Tap a slot to open the shared
 * player picker, tap a bench chip then a slot (or drag) to sub a player into
 * the round each court is currently showing, drag a playing player onto the
 * bench to rest them. Edits write into state.rounds[courtRounds[i]].courts[i]
 * through two PURE helpers tested here:
 *
 *   applyCourtPlacement(rounds, courtRounds, numCourts, courtIdx, team, k, id)
 *     → fresh rounds with `id` in that slot, cleared from every court's
 *       currently-shown entry AND every court of the target round (a player is
 *       never on two courts, now or when a court later advances).
 *   applyCourtRemoval(rounds, courtRounds, numCourts, id)
 *     → fresh rounds with `id` blanked from every currently-shown entry, or
 *       null when nothing changed.
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
const court = (t1, t2) => ({ team1: t1, team2: t2 });

// ── applyCourtPlacement ────────────────────────────────────────────
{
  const applyCourtPlacement = load('applyCourtPlacement');
  if (!applyCourtPlacement) {
    failures.push('applyCourtPlacement is not defined in public/index.html');
  } else {
    // 1. Bench player into an empty slot.
    {
      const rounds = [{ label: 'R1', courts: [court(['a', ''], ['c', 'd'])] }];
      const out = applyCourtPlacement(rounds, [0], 1, 0, 'team1', 1, 'x');
      check('placement: bench player lands in the tapped slot',
        out && out[0].courts[0].team1[1] === 'x');
      check('placement: does not mutate the input rounds',
        rounds[0].courts[0].team1[1] === '');
    }
    // 2. No double-booking on the same round: placing a player already on
    //    another court clears them there.
    {
      const rounds = [{ label: 'R1', courts: [court(['a', 'b'], ['c', 'd']), court(['e', 'f'], ['g', 'h'])] }];
      const out = applyCourtPlacement(rounds, [0, 0], 2, 0, 'team2', 0, 'e');
      check('placement: player moved off their old court (same round)',
        out[0].courts[1].team1[0] === '' && out[0].courts[0].team2[0] === 'e');
    }
    // 3. Courts on different rounds: the player is cleared from the OTHER
    //    court's shown round AND from every court of the target round.
    {
      const rounds = [
        { label: 'R1', courts: [court(['a', 'b'], ['c', 'd']), court(['e', 'f'], ['g', 'h'])] },
        { label: 'R2', courts: [court(['', ''], ['', '']), court(['e', 'x'], ['y', 'z'])] },
      ];
      // Court 0 shows R2, court 1 shows R1. Move 'e' (playing on court 1) onto court 0.
      const out = applyCourtPlacement(rounds, [1, 0], 2, 0, 'team1', 0, 'e');
      check('placement: cleared from the other court\'s shown round',
        out[0].courts[1].team1[0] === '');
      check('placement: cleared from every court of the target round',
        out[1].courts[1].team1[0] === '');
      check('placement: landed in the target slot',
        out[1].courts[0].team1[0] === 'e');
    }
    // 4. Pads missing court entries in the target round (extra court ticked on).
    {
      const rounds = [{ label: 'R1', courts: [court(['a', 'b'], ['c', 'd'])] }];
      const out = applyCourtPlacement(rounds, [0, 0], 2, 1, 'team1', 0, 'x');
      check('placement: pads a missing court entry and places there',
        out[0].courts[1] && out[0].courts[1].team1[0] === 'x'
        && out[0].courts[1].team2.join('') === '');
    }
    // 5. Missing target round → null (no crash, no write).
    {
      const out = applyCourtPlacement([], [0], 1, 0, 'team1', 0, 'x');
      check('placement: missing round returns null', out === null);
    }
  }
}

// ── applyCourtRemoval ──────────────────────────────────────────────
{
  const applyCourtRemoval = load('applyCourtRemoval');
  if (!applyCourtRemoval) {
    failures.push('applyCourtRemoval is not defined in public/index.html');
  } else {
    const mk = () => ([
      { label: 'R1', courts: [court(['a', 'b'], ['c', 'd']), court(['e', 'f'], ['g', 'h'])] },
      { label: 'R2', courts: [court(['a', 'x'], ['y', 'z']), court(['', ''], ['', ''])] },
    ]);
    // 1. Rests a playing player: blanks their slot in the shown round only.
    {
      const rounds = mk();
      const out = applyCourtRemoval(rounds, [0, 0], 2, 'a');
      check('removal: blanks the player\'s shown slot',
        out && out[0].courts[0].team1[0] === '');
      check('removal: other rounds keep their entries',
        out && out[1].courts[0].team1[0] === 'a');
      check('removal: does not mutate the input rounds',
        rounds[0].courts[0].team1[0] === 'a');
    }
    // 2. Player not on any shown court → null (nothing to save).
    {
      const out = applyCourtRemoval(mk(), [0, 0], 2, 'zz');
      check('removal: no-op returns null', out === null);
    }
    // 3. Respects per-court rounds: only the entry each court is showing.
    {
      const out = applyCourtRemoval(mk(), [1, 0], 2, 'a');
      check('removal: per-court rounds — R2 entry blanked, R1 entry kept',
        out && out[1].courts[0].team1[0] === '' && out[0].courts[0].team1[0] === 'a');
    }
  }
}

// ── markup + wiring ────────────────────────────────────────────────
{
  const cardsSrc = extractFn('renderCourtControls', html) || '';
  check('court cards render tappable/droppable slots',
    cardsSrc.includes('crt-slot') && cardsSrc.includes('crtSlotTap') && cardsSrc.includes('crtDrop'));
  check('filled court slots are draggable', cardsSrc.includes('crtDragStart'));
  check('court cards close an orphaned picker before rebuilding',
    cardsSrc.includes('crt-slot') && cardsSrc.includes('closePlayerPicker'));
  const benchSrc = extractFn('renderRestingPlayers', html) || '';
  check('bench reuses the Friendly bench card + chips',
    benchSrc.includes('frb-bench') && benchSrc.includes('frb-chip rest-chip'));
  check('bench chips arm on tap and drag onto slots',
    benchSrc.includes('crtPickPlayer') && benchSrc.includes('crtDragStart'));
  check('bench accepts drops to rest a playing player', benchSrc.includes('crtDropToBench'));
  check('wait-length group labels reuse the bench label class', benchSrc.includes('frb-side rest-side'));
  const pickerSrc = extractFn('openCourtSlotPicker', html) || '';
  check('slot tap opens the shared picker popover', pickerSrc.includes('openPslotAt'));
  // Bench placement: beside the round list (sticky side panel), not the court cards.
  const boardAt = html.indexOf('<div class="crt-board">');
  check('bench board wraps the round list',
    boardAt > -1 && html.indexOf('id="restingStrip"', boardAt) > -1
    && html.indexOf('id="roundListWrap"', boardAt) > -1
    && html.indexOf('id="roundListWrap"', boardAt) < html.indexOf('</div><!-- /courts tab -->'));
  check('court cards grid is no longer inside the bench board',
    html.indexOf('id="courtCtrlGrid"') < boardAt);
  // Bench chips drop onto round/Up Next editor slots via the shared commit.
  const pickSrc = extractFn('pickPslot', html) || '';
  const commitSrc = extractFn('commitPslotValue', html) || '';
  check('commitPslotValue sets the slot face in place',
    commitSrc.includes('playerSlotFace') && commitSrc.includes('refreshCourtChip'));
  check('popover pick routes through the shared commit', pickSrc.includes('commitPslotValue'));
  check('.pslot slots accept bench-chip drops (delegated)',
    /closest\('\.pslot'\)/.test(html) && html.split('commitPslotValue').length >= 4);
  const isEditingSrc = extractFn('isEditing', html) || '';
  check('isEditing() holds the poll while a bench chip is armed',
    isEditingSrc.includes('__crtSel'));
  // The Courts board is stacked at every width (bench above the round list,
  // no side column) and must stretch its columns — without align-items:stretch
  // .crt-main shrink-wraps to the round list's nowrap summaries and the whole
  // page overflows sideways.
  check('board stacks with stretched columns (no sideways overflow)',
    /\.crt-board\{display:flex;flex-direction:column;align-items:stretch/.test(html)
    && /#frMatchups\{display:flex;flex-direction:column;align-items:stretch/.test(html));
  check('bench side column is gone (no sticky 232px bench panel)',
    !/\.crt-bench-panel\{[^}]*position:sticky/.test(html));
  // Desktop: the bench docks under the sidebar nav (#benchDock); it returns
  // inline to the board on mobile or when the sidebar collapses to the rail.
  const sbAt = html.indexOf('id="adminSidebar"');
  check('bench dock sits inside the sidebar below the nav',
    sbAt > -1 && html.indexOf('id="benchDock"', sbAt) > -1
    && html.indexOf('id="benchDock"', sbAt) < html.indexOf('class="asb-foot"', sbAt));
  const placeSrc = extractFn('placeCourtsBench', html) || '';
  check('placeCourtsBench docks on desktop, returns inline otherwise',
    placeSrc.includes('benchDock') && placeSrc.includes('restingStrip')
    && placeSrc.includes("collapsed") && placeSrc.includes('min-width:641px')
    && placeSrc.includes('insertBefore'));
  const setTabSrc = extractFn('setAdminTab', html) || '';
  check('tab switches and sidebar toggle re-place the bench',
    setTabSrc.includes('placeCourtsBench')
    && (extractFn('toggleAdminSidebar', html) || '').includes('placeCourtsBench'));
  check('collapsed rail hides the dock', html.includes('.admin-sidebar.collapsed #benchDock{display:none}'));
  // Friendly bench: rendered into its own sidebar dock (innerHTML, not moved —
  // the whole matchup board rebuilds on every interaction).
  const frMatchupsSrc = extractFn('renderFriendlyMatchups', html) || '';
  check('friendly bench renders into #frBenchDock on desktop, inline otherwise',
    html.indexOf('id="frBenchDock"', sbAt) > -1
    && html.indexOf('id="frBenchDock"', sbAt) < html.indexOf('class="asb-foot"', sbAt)
    && frMatchupsSrc.includes('frBenchDock') && frMatchupsSrc.includes('min-width:641px')
    && frMatchupsSrc.includes('collapsed')
    && html.includes('.admin-sidebar.collapsed #frBenchDock{display:none}'));
  check('friendly board no longer keeps a sticky side column',
    !/\.frb-side-panel\{[^}]*position:sticky/.test(html));
  // The old floating/parkable strip is fully removed.
  check('old strip drag machinery is gone',
    !html.includes('initRestStripDrag') && !html.includes('restStripPos') && !html.includes('rest-floating'));
}

// ── report ─────────────────────────────────────────────────────────
console.log('test-court-bench — Courts-tab bench board\n');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log('  PASS  applyCourtPlacement: places, un-double-books, pads, pure');
  console.log('  PASS  applyCourtRemoval: rests shown slots only, null on no-op, pure');
  console.log('  PASS  bench + court-card wiring reuses the Friendly board system');
  console.log('\nRESULT: PASS — court bench assertions green.');
  process.exit(0);
}
