#!/usr/bin/env node
/*
 * test-court-games.js — guard for the late-opening court label.
 *
 * Not every court opens at 9pm. The 5:30 court joins a couple of rounds in, so
 * its courtRounds index sits permanently below the others': the board showed
 * "Round 11" on that card while the rest showed "Round 12", and it never caught
 * up. Nothing is actually wrong — that court has simply played fewer games — so
 * it is labelled by its OWN game count instead.
 *
 * PURE helpers in public/index.html:
 *
 *   courtHasLineup(round, courtIdx)        -> bool. The padded empty slot
 *       ({team1:['',''],team2:['','']}) is NOT a game.
 *   courtFirstRound(rounds, courtIdx)      -> first round index played, -1 if never.
 *   courtGameNumber(rounds, courtIdx, ri)  -> 1-based own-game number at ri; the
 *       current round always counts (filled or not); 0 before the court opens.
 *   courtRoundLabel(rounds, courtIdx, ri)  -> { text, title }. Courts that ran
 *       all night keep the shared round label unchanged; only a late court
 *       switches to "Game N".
 *
 * Extracts the helpers from the inline <script> and asserts their behaviour.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

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

const NAMES = ['courtHasLineup', 'courtFirstRound', 'courtGameNumber', 'courtRoundLabel'];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
// All four are loaded together — courtRoundLabel calls the other three.
const api = new Function(`${srcs.join('\n')}; return { ${NAMES.join(', ')} };`)();
const { courtHasLineup, courtFirstRound, courtGameNumber, courtRoundLabel } = api;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const EMPTY = () => ({ team1: ['', ''], team2: ['', ''] });
const filled = (n) => ({ team1: ['p' + n + 'a', 'p' + n + 'b'], team2: ['p' + n + 'c', 'p' + n + 'd'] });

// Three courts (indices 0,1,2). Court index 1 is the 5:30 court: it sits empty
// for rounds 0 and 1, then plays from round 2 on. 13 rounds, like the real board.
const rounds = [];
for (let r = 0; r < 13; r++) {
  rounds.push({
    label: `Round ${r + 1}`,
    courts: [filled(r), r < 2 ? EMPTY() : filled(r + 100), filled(r + 200)],
  });
}

// ── courtHasLineup ──
check('courtHasLineup true for a filled slot', courtHasLineup(rounds[0], 0) === true);
check('courtHasLineup false for the padded empty slot', courtHasLineup(rounds[0], 1) === false);
check('courtHasLineup true once the late court opens', courtHasLineup(rounds[2], 1) === true);
check('courtHasLineup false for a missing court slot', courtHasLineup(rounds[0], 9) === false);
check('courtHasLineup false for a null round', courtHasLineup(null, 0) === false);
check('courtHasLineup true when only one seat is filled',
  courtHasLineup({ courts: [{ team1: ['x', ''], team2: ['', ''] }] }, 0) === true);

// ── courtFirstRound ──
check('courtFirstRound 0 for a court that ran all night', courtFirstRound(rounds, 0) === 0);
check('courtFirstRound 2 for the 5:30 court', courtFirstRound(rounds, 1) === 2);
check('courtFirstRound -1 for a court that never plays', courtFirstRound(rounds, 9) === -1);
check('courtFirstRound -1 on a non-array', courtFirstRound(null, 0) === -1);

// ── courtGameNumber ──
// A court that played every round: its game number IS the round number.
check('all-night court: game number tracks the round number',
  courtGameNumber(rounds, 0, 0) === 1 && courtGameNumber(rounds, 0, 11) === 12 && courtGameNumber(rounds, 0, 12) === 13);
// The 5:30 court, two rounds behind: at Round 12 (index 11) it is on its 10th game.
check('late court on round index 11 is its 10th game', courtGameNumber(rounds, 1, 11) === 10);
check('late court on round index 10 is its 9th game', courtGameNumber(rounds, 1, 10) === 9);
check('late court first game is game 1', courtGameNumber(rounds, 1, 2) === 1);
check('late court is 0 before it opens', courtGameNumber(rounds, 1, 0) === 0 && courtGameNumber(rounds, 1, 1) === 0);
check('never-played court is always 0', courtGameNumber(rounds, 9, 5) === 0);
check('courtGameNumber 0 on empty rounds', courtGameNumber([], 0, 0) === 0);
check('courtGameNumber clamps a round index past the end', courtGameNumber(rounds, 0, 999) === 13);

// The current round always counts, so the number does not jump while the admin
// fills the slots: an empty current round reads the same as a filled one.
const midEdit = rounds.map((r, i) => (i === 11
  ? { ...r, courts: r.courts.map((c, ci) => (ci === 1 ? EMPTY() : c)) } : r));
check('current round counts even while still empty (no jump mid-edit)',
  courtGameNumber(midEdit, 1, 11) === 10);

// A court that stops early and resumes only counts the rounds it actually played.
const gapped = rounds.map((r, i) => (i === 5
  ? { ...r, courts: r.courts.map((c, ci) => (ci === 1 ? EMPTY() : c)) } : r));
check('a skipped round does not count toward the game number',
  courtGameNumber(gapped, 1, 11) === 9);

// ── courtRoundLabel ──
const all = courtRoundLabel(rounds, 0, 11);
check('all-night court keeps the shared round label', all.text === 'Round 12');
check('all-night court gets no hover text', all.title === '');
const late = courtRoundLabel(rounds, 1, 11);
check('late court reads as its own game', late.text === 'Game 10');
check('late court hover still names the underlying round', late.title.indexOf('Round 12') === 0);
const never = courtRoundLabel(rounds, 9, 11);
check('never-played court falls back to the round label', never.text === 'Round 12' && never.title === '');
check('label falls back to "Round N" when the round carries no label',
  courtRoundLabel([{ courts: [filled(0)] }], 0, 0).text === 'Round 1');
check('label survives a missing rounds array', courtRoundLabel(null, 0, 3).text === 'Round 4');

// Inputs are never mutated.
const before = JSON.stringify(rounds);
courtRoundLabel(rounds, 1, 11);
courtGameNumber(rounds, 1, 11);
check('helpers never mutate the rounds they read', JSON.stringify(rounds) === before);

// ── DOM glue: both boards must actually use the helper ──
check('admin court card labels via courtRoundLabel',
  /const rlab = courtRoundLabel\(state\.rounds, i, ri\)/.test(html)
  && /class="crt-rnav-lbl"[^>]*>\$\{escHtml\(rlab\.text\)\}/.test(html));
check('viewer court card labels via courtRoundLabel',
  /courtRoundLabel\(state\.rounds, i, courtRounds\[i\] \?\? 0\)/.test(html)
  && /buildCourtCard\(courtLabel\(i\), court, round \? rlab\.text : null/.test(html));

if (failures.length) {
  console.error('test-court-games.js FAILED:');
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('test-court-games.js: all checks passed');
