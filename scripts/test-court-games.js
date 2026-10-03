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

const NAMES = ['courtHasLineup', 'courtGameNumber', 'courtGameLabel',
  'normalizeCourtGameBase', 'setCourtGameBaseAt', 'courtGameBaseFor'];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
// courtGameLabel calls courtGameNumber, so they load together — and
// courtGameBaseFor reads the cap, which is lifted from the page rather than
// restated here, so a change to it can't drift past this guard.
const capSrc = (html.match(/const MAX_GAME_NUMBER\s*=\s*\d+;/) || [])[0];
if (!capSrc) { console.error('FAIL: MAX_GAME_NUMBER not found in public/index.html'); process.exit(1); }
const api = new Function(`${capSrc}\n${srcs.join('\n')}; return { ${NAMES.join(', ')} };`)();
const { courtHasLineup, courtGameNumber, courtGameLabel,
  normalizeCourtGameBase, setCourtGameBaseAt, courtGameBaseFor } = api;

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

// ── the typed correction ──
// The count is right until the record and the hall disagree (the night started
// before anyone opened the page, a game went in twice). The organiser types the
// number on the court; only the difference is kept, so the games after it count
// on by themselves.
{
  const played = [
    { court: 0, team1: ['a', 'b'], team2: ['c', 'd'] },
    { court: 0, team1: ['e', 'f'], team2: ['g', 'h'] },
  ];
  // Two games played, one on: the card counts Game 3 but the hall calls it 7.
  check('the card counts its own games with no correction',
    courtGameNumber(played, 0, true, 0) === 3);
  const base = courtGameBaseFor(played, 0, 7);
  check('the correction is the difference, not the number', base === 4);
  check('the corrected card reads what was typed',
    courtGameLabel(played, 0, true, base) === 'Game 7');
  // THE point of storing a difference: the next game carries on from 7.
  const after = played.concat([{ court: 0, team1: ['i', 'j'], team2: ['k', 'l'] }]);
  check('the game after a corrected one counts on from it',
    courtGameLabel(after, 0, true, base) === 'Game 8');
  // ...and Previous game counts back down again.
  check('undoing a game counts back down from the correction',
    courtGameLabel([played[0]], 0, true, base) === 'Game 6');
  // A correction belongs to one court only.
  check('another court is untouched by it', courtGameLabel(played, 1, true, 0) === 'Game 1');
  // Counting DOWN is just as legitimate — a card reading too high.
  const down = courtGameBaseFor(played, 0, 1);
  check('a card can be corrected downwards', down === -2);
  check('and reads the lower number', courtGameLabel(played, 0, true, down) === 'Game 1');
  // A correction can never take a live court below Game 1.
  check('a correction can never produce Game 0 or less',
    courtGameLabel(played, 0, true, -99) === 'Game 1');
  // A free court still says Free, whatever correction it carries.
  check('a corrected court between games still says Free',
    courtGameLabel(played, 0, false, base) === 'Free');
}

// Junk in, no correction out — the box is typed into by hand.
{
  const played = [];
  check('an empty box is refused', courtGameBaseFor(played, 0, '') === null);
  check('a word is refused', courtGameBaseFor(played, 0, 'seven') === null);
  check('zero is refused', courtGameBaseFor(played, 0, 0) === null);
  check('a negative game number is refused', courtGameBaseFor(played, 0, -3) === null);
  check('an absurd game number is refused', courtGameBaseFor(played, 0, 100000) === null);
  check('a typed number is taken', courtGameBaseFor(played, 0, '5') === 4);
  check('a decimal is floored, not refused', courtGameBaseFor(played, 0, 5.9) === 4);
}

// The correction array is a per-court array like every other one on these cards.
{
  check('a missing array normalizes to zeros',
    JSON.stringify(normalizeCourtGameBase(undefined, 3)) === '[0,0,0]');
  check('garbage entries normalize to zero',
    JSON.stringify(normalizeCourtGameBase(['x', null, 2], 3)) === '[0,0,2]');
  check('it is padded and truncated to the court count',
    JSON.stringify(normalizeCourtGameBase([1, 2, 3, 4], 2)) === '[1,2]');
  check('negative corrections survive normalizing',
    JSON.stringify(normalizeCourtGameBase([-2], 1)) === '[-2]');
  const set = setCourtGameBaseAt([0, 0], 1, 2, 4);
  check('setting one court leaves the others alone', JSON.stringify(set) === '[0,4]');
  check('it returns a new array', JSON.stringify(setCourtGameBaseAt([0, 0], 5, 2, 4)) === '[0,0]');
  // Dropping a court shifts every per-court array down; the correction must go
  // with it or the courts that stay inherit the dropped court's numbering.
  const dropSrc = extractFn('applyCourtDrop', html) || '';
  check('applyCourtDrop shifts the correction with the rest',
    /courtGameBase:\s*drop\(/.test(dropSrc));
}

// The number is TYPED on the card — the whole point of the change. A read-only
// label here would be the old behaviour wearing the new helpers.
{
  const admin = extractFn('renderCourtControls', html) || '';
  check('the card renders a game-number box', /class="crt-game-inp"/.test(admin));
  check('the box saves through setCourtGameNumber', /setCourtGameNumber\(/.test(admin));
  check('the save handler exists', extractFn('setCourtGameNumber', html) !== null);
  // Both screens must read the correction, not just the admin card.
  const viewer = extractFn('renderViewer', html) || '';
  check('the hall screen reads the correction too',
    /normalizeCourtGameBase\(/.test(viewer) && /courtGameLabel\([^)]*gameBase/.test(viewer));
}

// ── the server keeps it to a shape ──
// courtGameBase rides the generic POST merge, which accepts anything it is not
// told to refuse — same treatment queue/played/wentHome get.
{
  const apiSrc = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'), 'utf8');
  check('a non-array is refused', apiSrc.includes("error: 'Invalid game numbering.'"));
  check('entries are coerced and capped both ways',
    /updates\.courtGameBase = updates\.courtGameBase\.slice\(0, MAX_COURT_SLOTS\)/.test(apiSrc)
    && /Math\.max\(-MAX_GAME_NUMBER, Math\.min\(MAX_GAME_NUMBER, n\)\)/.test(apiSrc));
  check('the night keeps its own numbering', /courtGameBase: state\.courtGameBase \|\| \[\]/.test(apiSrc));
  const stateApi = require(path.join(path.resolve(__dirname, '..'), 'api', 'state.js'));
  const night = {
    sessionDate: '2026-09-18', players: [{ id: 'p1', name: 'A' }], roster: [{ id: 'p1', name: 'A', points: 0 }],
    rounds: [], sessions: {}, numCourts: 2, courtGameBase: [6, 0],
  };
  const fresh = stateApi.applySessionDateChange(night, '2026-09-20', '2026-09-20');
  check('a new night starts back at Game 1',
    fresh.ok && Array.isArray(fresh.state.courtGameBase) && fresh.state.courtGameBase.length === 0);
  const back = stateApi.applySessionDateChange(fresh.state, '2026-09-18', '2026-09-20');
  check('reopening a night brings its numbering back',
    back.ok && JSON.stringify(back.state.courtGameBase) === JSON.stringify([6, 0]));
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
  console.log('  PASS  a typed number is kept as a difference, so the night counts on from it');
  console.log('  PASS  the server keeps it to a shape, per night');
  console.log('  PASS  the shared-round label stays deleted, and both screens agree');
  console.log('\nRESULT: PASS — court game-number assertions green.');
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) red.`);
process.exit(1);
