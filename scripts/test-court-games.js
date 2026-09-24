#!/usr/bin/env node
/*
 * test-court-games.js — guard for the game number on a court card.
 *
 * WHAT CHANGED. This file used to be about ONE awkward case: not every court
 * opens at 9pm, and the 5:30 court's round index sat permanently below the
 * others', so its card read "Round 11" while the rest read "Round 12" and it
 * never caught up. Nothing was wrong — that court had simply played fewer
 * games — so it alone was labelled by its own count:
 *
 *   courtHasLineup / courtFirstRound / courtGameNumber(rounds, court, roundIdx)
 *   courtRoundLabel(rounds, court, roundIdx) -> "Round 12", or "Game 9" for a
 *                                               court that opened late
 *
 * The special case is now the only case. Courts no longer share rounds at all,
 * so there is no shared number left for a court to be "behind" on, and every
 * card counts its own games out of the record of what has been played:
 *
 *   courtGameNumber(played, courtIdx, onCourt) -> games played, +1 for the one on
 *   courtGameLabel(played, courtIdx, onCourt)  -> "Game N", or "Free" between games
 *
 * courtHasLineup survives, because padding and the court-drop logic still ask
 * whether a slot holds a real game or the empty {team1:['',''],team2:['','']}.
 *
 * Exit 0 = green, exit 1 = red.
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

const NAMES = ['courtHasLineup', 'courtGameNumber', 'courtGameLabel'];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
// courtGameLabel calls courtGameNumber, so they load together.
const api = new Function(`${srcs.join('\n')}; return { ${NAMES.join(', ')} };`)();
const { courtHasLineup, courtGameNumber, courtGameLabel } = api;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const EMPTY = () => ({ team1: ['', ''], team2: ['', ''] });
const filled = (n) => ({ team1: ['p' + n + 'a', 'p' + n + 'b'], team2: ['p' + n + 'c', 'p' + n + 'd'] });

// ── courtHasLineup ──
// Still needed: padRoundsToCourts pads a new court with an empty slot, and that
// padding is NOT a game.
{
  const row = { label: 'Live', courts: [filled(1), EMPTY(), filled(2)] };
  check('courtHasLineup true for a filled slot', courtHasLineup(row, 0) === true);
  check('courtHasLineup false for the padded empty slot', courtHasLineup(row, 1) === false);
  check('courtHasLineup false for a court that does not exist', courtHasLineup(row, 9) === false);
  check('courtHasLineup false on a missing row', courtHasLineup(null, 0) === false);
  // One name is enough to make it a game: a half-arranged court is still in use.
  check('courtHasLineup true with a single name',
    courtHasLineup({ courts: [{ team1: ['x', ''], team2: ['', ''] }] }, 0) === true);
}

// ── courtGameNumber ──
{
  const played = [
    { court: 0, team1: ['a', 'b'], team2: ['c', 'd'] },
    { court: 1, team1: ['e', 'f'], team2: ['g', 'h'] },
    { court: 0, team1: ['i', 'j'], team2: ['k', 'l'] },
  ];
  check('a court counts only its own finished games', courtGameNumber(played, 0, false) === 2);
  check('another court counts only its own', courtGameNumber(played, 1, false) === 1);
  check('a court that has not played reads zero', courtGameNumber(played, 2, false) === 0);
  // The game ON the court is the one the card is describing, so it counts.
  check('the game in progress counts as this court\'s next number',
    courtGameNumber(played, 0, true) === 3);
  check('a court with nothing on it counts only what it finished',
    courtGameNumber(played, 2, true) === 1);
  check('an empty record is safe', courtGameNumber([], 0, false) === 0);
  check('a missing record is safe', courtGameNumber(null, 0, true) === 1);
}

// A game recovered from a night saved under the old round model may carry no
// court key at all. It must count against court 0 rather than vanishing.
{
  const played = [{ team1: ['a', 'b'], team2: ['c', 'd'] }];
  check('a game with no court recorded counts as court 1', courtGameNumber(played, 0, false) === 1);
  check('and is not counted against another court', courtGameNumber(played, 1, false) === 0);
}

// ── courtGameLabel ──
{
  const played = [{ court: 0, team1: ['a', 'b'], team2: ['c', 'd'] }];
  check('a court with a game on it names its number', courtGameLabel(played, 0, true) === 'Game 2');
  // "Game 1" on a court with nobody on it would be the number of a game that
  // has already finished, which reads as though it were still running.
  check('a court between games says it is free', courtGameLabel(played, 0, false) === 'Free');
  check('the first game of the night on a fresh court is Game 1',
    courtGameLabel([], 3, true) === 'Game 1');
}

// ── the round-based versions stay deleted ──
// courtRoundLabel returned { text, title } and read a round index. Its return
// would mean a card is describing a shared round again.
for (const dead of ['courtFirstRound', 'courtRoundLabel']) {
  check(`${dead}() stays deleted`, extractFn(dead, html) === null);
}

// Both the hall screen and the admin board must use the same label, or the
// organiser's phone and the screen on the wall disagree about the same court.
{
  const viewer = extractFn('renderViewer', html) || '';
  const admin = extractFn('renderCourtControls', html) || '';
  check('the hall screen labels cards with courtGameLabel', /courtGameLabel\s*\(/.test(viewer));
  check('the admin board labels cards with courtGameLabel', /courtGameLabel\s*\(/.test(admin));
}

// ── report ──
console.log('\ntest-court-games — each court counts its own games\n');
if (!failures.length) {
  console.log('  PASS  the empty padding slot is not a game');
  console.log('  PASS  a court counts only the games it played, plus the one on it');
  console.log('  PASS  a court between games says Free rather than a finished number');
  console.log('  PASS  the shared-round label stays deleted, and both screens agree');
  console.log('\nRESULT: PASS — court game-number assertions green.');
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) red.`);
process.exit(1);
