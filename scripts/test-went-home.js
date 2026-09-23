#!/usr/bin/env node
/* test-went-home — marking a player as gone home.
 *
 * People leave halfway through a night. Until now nothing recorded that, so the
 * Courts bench kept them in the waiting list forever and their wait count ran
 * up ("18 ROUNDS"), which made the whole longest-wait-first ordering useless
 * for the people actually still there.
 *
 * `state.wentHome` is a plain list of player ids for the LIVE night only. It is
 * deliberately NOT a removal: they played, so they keep their attendance,
 * payment, points and draw entry. The only thing it changes is that nothing
 * offers them another game.
 *
 * Pure helper: normalizeWentHome (public/index.html). Everything else here is
 * a wiring assertion against index.html / api/state.js. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'api', 'state.js'), 'utf8');
const stateApi = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function extractFn(name, src) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const load = (name) => new Function(`${extractFn(name, html)}; return ${name};`)();

console.log('\ntest-went-home — a player who leaves stops being offered a game\n');

// ── normalizeWentHome ────────────────────────────────────────────────
const normalizeWentHome = load('normalizeWentHome');
const players = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

check('keeps ids that are in tonight\'s session',
  JSON.stringify(normalizeWentHome(['p1', 'p3'], players)) === JSON.stringify(['p1', 'p3']));
check('order is preserved (it is a log of who left, in order)',
  JSON.stringify(normalizeWentHome(['p3', 'p1'], players)) === JSON.stringify(['p3', 'p1']));
check('drops anyone not playing tonight — unticking someone forgets they left',
  JSON.stringify(normalizeWentHome(['p1', 'p9'], players)) === JSON.stringify(['p1']));
check('dedupes', JSON.stringify(normalizeWentHome(['p1', 'p1'], players)) === JSON.stringify(['p1']));
check('ignores non-strings', JSON.stringify(normalizeWentHome([null, 7, {}, 'p2'], players)) === JSON.stringify(['p2']));
check('ignores the empty string', JSON.stringify(normalizeWentHome(['', 'p2'], players)) === JSON.stringify(['p2']));
check('a non-array is empty', JSON.stringify(normalizeWentHome('p1', players)) === '[]');
check('undefined is empty', JSON.stringify(normalizeWentHome(undefined, players)) === '[]');
check('no players means nobody can have gone home', JSON.stringify(normalizeWentHome(['p1'], [])) === '[]');
check('never mutates its input', (() => {
  const src = ['p1', 'p1', 'zz'];
  normalizeWentHome(src, players);
  return JSON.stringify(src) === JSON.stringify(['p1', 'p1', 'zz']);
})());

// ── the bench drops them and lists them separately ───────────────────
check('resting is filtered by the gone-home set',
  /const resting = \(state\.players \|\| \[\]\)\.filter\(p => !activePlayers\.has\(p\.id\) && !gone\.has\(p\.id\)\)/.test(html));
check('a "Gone home" rail is rendered', html.includes('GONE HOME') && html.includes('gone-chip'));
check('every bench chip carries the house button', html.includes('goneHomeBtnHTML(p, false)'));
check('a gone-home chip carries the undo', html.includes('goneHomeBtnHTML(p, true)'));
check('the house button does not arm the chip', /class="chip-home[\s\S]{0,60}event\.stopPropagation\(\);toggleWentHome/.test(html));
check('the bench hint mentions it', /house button marks someone gone home/.test(html));
check('the chip button is styled', html.includes('.chip-home{') && html.includes('.rest-chip.gone-chip{'));

// ── on-court players can be marked too ───────────────────────────────
// "I'm off after this game" is said mid-game, when the player is on a court and
// nowhere near the bench. Marking them must NOT disturb the game in progress.
check('every filled court slot carries the house', html.includes('class="chip-home crt-home'));
check('it does not also tap the slot', /crt-home[\s\S]{0,120}event\.stopPropagation\(\);toggleWentHome/.test(html));
check('the wording says "after this game"', html.includes('is going home after this game'));
check('an already-marked slot offers the way back', html.includes('tap to bring them back in'));
check('the set is read once per render, not once per slot',
  /const goneNow = wentHomeSet\(\);/.test(html) && html.includes('goneNow.has(id)'));
check('the remove x is still there and still last',
  /\$\{home\}<span class="x" onclick="event\.stopPropagation\(\);crtClearSlot/.test(html));
check('the court slot button is positioned', html.includes('.crt-slot .chip-home{margin-left:auto}'));
check('marking someone never touches the round they are playing',
  !(extractFn('toggleWentHome', html) || '').includes('rounds'));

// ── the picker tells you why they are missing ────────────────────────
check('the picker builds a gone-home group', (html.match(/goneHome = \[\]/g) || []).length === 2);
check('both pickers pass it through', (html.match(/\{ free, resting, onCourt, goneHome, selectedId, levelOf \}/g) || []).length === 2);
check('the group is labelled', html.includes("goneHome: 'Gone home'"));
check('the group is dimmed and last', /goneF\.length\) html \+= `<div class="pslot-group">\$\{labels\.goneHome\}<\/div>`[\s\S]{0,140}dim: true/.test(html));
check('the count includes them', html.includes('freeF.length + restF.length + courtF.length + goneF.length'));
check('the currently-picked player is never hidden as gone home',
  (html.match(/if \(gone\.has\(p\.id\) && p\.id !== selectedId\)/g) || []).length === 2);

// ── the toggle writes and self-heals ─────────────────────────────────
const toggleSrc = extractFn('toggleWentHome', html) || '';
check('the toggle posts the list', toggleSrc.includes("apiPost({ wentHome })"));
check('it renders optimistically before the write', /state\.wentHome = wentHome;[\s\S]{0,120}renderCourtControls\(\);[\s\S]{0,80}await apiPost/.test(toggleSrc));
check('a refused write is checked, not assumed OK (apiPost resolves on 4xx)',
  toggleSrc.includes('res.error || res.ok === false'));
check('a refused write puts the bench back', /state\.wentHome = prev;[\s\S]{0,90}renderCourtControls/.test(toggleSrc));
check('a 401 bounces out without reverting', toggleSrc.includes('if (res === null) return;'));

// ── the server: per-night, validated, cleared on the date change ─────
check('DEFAULT_STATE has the list', /wentHome: \[\]/.test(apiSrc));
check('a non-array is refused', apiSrc.includes("error: 'Invalid gone-home list.'"));
check('the list is deduped and string-filtered server-side',
  /updates\.wentHome = \[\.\.\.new Set\(updates\.wentHome\.filter\(\(id\) => typeof id === 'string' && id\)\)\]/.test(apiSrc));

// applySessionDateChange is the real thing, so this is behavioural, not a grep.
const before = {
  sessionDate: '2026-09-18', players: [{ id: 'p1', name: 'A' }], roster: [{ id: 'p1', name: 'A', points: 0 }],
  rounds: [], sessions: {}, wentHome: ['p1'], numCourts: 2,
};
const after = stateApi.applySessionDateChange(before, '2026-09-20', '2026-09-20');
check('a new night starts with nobody gone home', after.ok && Array.isArray(after.state.wentHome) && after.state.wentHome.length === 0);
check('the outgoing night is still snapshotted', !!after.state.sessions['2026-09-18']);

const samePlusEdit = stateApi.applySessionDateChange({ ...before }, '2026-09-18', '2026-09-18');
check('re-setting the SAME date leaves the list alone', samePlusEdit.ok
  && JSON.stringify(samePlusEdit.state.wentHome) === JSON.stringify(['p1']));

// ── it is not a removal ──────────────────────────────────────────────
check('nothing strips a gone-home player from state.players',
  !/wentHome[\s\S]{0,400}state\.players = \(state\.players \|\| \[\]\)\.filter/.test(html));
check('nothing strips them from rounds already played',
  !/toggleWentHome[\s\S]{0,600}stripPlayerFromRounds/.test(html));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? '\nRESULT: FAIL\n' : '\nRESULT: PASS — gone-home is recorded, reversible and per-night.\n');
process.exit(fail ? 1 : 0);
