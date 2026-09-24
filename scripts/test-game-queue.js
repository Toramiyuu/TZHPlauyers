#!/usr/bin/env node
/*
 * test-game-queue.js — guard for the shared game queue.
 *
 * The night used to be planned in ROUNDS: one row of state.rounds held every
 * court at once. Court 2 goes to deuce and takes twenty minutes while 3 and 4
 * finish in eight, so 3 and 4 advance without it and the people on the slow
 * court quietly play fewer games all night.
 *
 * Now there is ONE shared queue belonging to no court. Whichever court frees up
 * first takes the top game that can actually start; a game whose players are
 * still on another court, or which is short of names, is passed over and KEEPS
 * its place. state.rounds is a one-row live board, state.played is the record.
 *
 * PURE helpers in public/index.html:
 *
 *   gameIds(game)                      -> the four ids in seat order
 *   liveCourtIds(rounds, cr, n, except)-> ids on a court now; `except` leaves
 *                                         out the court that is asking, whose
 *                                         four are walking off
 *   gameReadiness(game, live, gone)    -> { state:'ready'|'short'|'gone'|'clash', ids }
 *   nextPlayableGame(queue, live, gone)-> { index, game, skipped[] }
 *   waitMinutes(played, players, live, now) -> { id: whole minutes waiting }
 *   playedGameCounts(played)           -> { id: games tonight }
 *   waitHeatLevel(min) / waitBandLabel(level)
 *   liveBoardRow(rounds, cr, n)        -> the one-row board, built per court
 *   historicGamesOf(rounds, cr, n)     -> an old multi-round night's games
 *   courtIsFree(rounds, cr, i)
 *   takeNextGame(state, courtIdx, at)  -> { rounds, queue, played, courtRounds,
 *                                           courtLive, took, finished, skipped }
 *   putGameBack(state, courtIdx)       -> the undo
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

// takeNextGame/putGameBack call setCourtLiveAt, which calls normalizeCourtLive,
// so the clock helpers load alongside them — same pattern as test-court-games.
const NAMES = [
  'normalizeCourtLive', 'setCourtLiveAt',
  'gameIds', 'liveCourtIds', 'gameReadiness', 'nextPlayableGame',
  'waitMinutes', 'playedGameCounts', 'waitHeatLevel', 'waitBandLabel',
  'liveBoardRow', 'historicGamesOf', 'courtIsFree', 'takeNextGame', 'putGameBack',
];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
// The band constants are top-level `const`s, so extractFn cannot see them.
// Reading them out of the source keeps this test honest: retune them in
// index.html and the expectations below follow rather than silently diverging.
const bandMatch = html.match(/const WAIT_BAND_MINUTES\s*=\s*(\d+)/);
const capMatch = html.match(/const WAIT_MAX_BAND\s*=\s*(\d+)/);
if (!bandMatch || !capMatch) {
  console.error('FAIL: WAIT_BAND_MINUTES / WAIT_MAX_BAND not found in public/index.html');
  process.exit(1);
}
const BAND = Number(bandMatch[1]);
const CAP = Number(capMatch[1]);
const api = new Function(
  `const WAIT_BAND_MINUTES = ${BAND}; const WAIT_MAX_BAND = ${CAP};\n`
  + `${srcs.join('\n')}; return { ${NAMES.join(', ')} };`
)();
const {
  gameIds, liveCourtIds, gameReadiness, nextPlayableGame, waitMinutes,
  playedGameCounts, waitHeatLevel, waitBandLabel, liveBoardRow, historicGamesOf,
  courtIsFree, takeNextGame, putGameBack,
} = api;

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

const EMPTY = () => ({ team1: ['', ''], team2: ['', ''] });
const game = (a, b, c, d) => ({ team1: [a, b], team2: [c, d] });

// ── gameIds ──
check('gameIds returns four ids in seat order',
  JSON.stringify(gameIds(game('a', 'b', 'c', 'd'))) === '["a","b","c","d"]');
check('gameIds tolerates a missing game', gameIds(null).length === 0);

// ── liveCourtIds ──
{
  const rounds = [{ label: 'Live', courts: [game('a', 'b', 'c', 'd'), game('e', 'f', 'g', 'h')] }];
  const cr = [0, 0];
  const all = liveCourtIds(rounds, cr, 2);
  check('liveCourtIds collects every court', all.size === 8 && all.has('a') && all.has('h'));
  const not0 = liveCourtIds(rounds, cr, 2, 0);
  check('liveCourtIds leaves out the asking court', not0.size === 4 && !not0.has('a') && not0.has('e'));
}

// ── gameReadiness ──
{
  const live = new Set(['x']);
  const gone = new Set(['z']);
  check('a full free game is ready',
    gameReadiness(game('a', 'b', 'c', 'd'), live, gone).state === 'ready');
  check('a game with a blank seat is short',
    gameReadiness(game('a', 'b', 'c', ''), live, gone).state === 'short');
  check('the same person twice is short, not a clash',
    gameReadiness(game('a', 'a', 'c', 'd'), live, gone).state === 'short');
  check('somebody gone home stops it',
    gameReadiness(game('a', 'b', 'c', 'z'), live, gone).state === 'gone');
  const clash = gameReadiness(game('a', 'b', 'c', 'x'), live, gone);
  check('somebody still on court is a clash', clash.state === 'clash');
  check('a clash names who is busy', clash.ids.length === 1 && clash.ids[0] === 'x');
  // A blank seat is the admin's own unfinished work. Reporting "clash" there
  // would send them looking at the wrong court.
  check('short is reported before clash',
    gameReadiness(game('a', 'b', '', 'x'), live, gone).state === 'short');
}

// ── nextPlayableGame ──
{
  const queue = [
    game('a', 'b', 'c', 'x'),   // clash
    game('a', 'b', 'c', ''),    // short
    game('m', 'n', 'o', 'p'),   // ready
  ];
  const pick = nextPlayableGame(queue, new Set(['x']), new Set());
  check('it takes the first game that can start', pick.index === 2);
  check('it reports what it passed over', pick.skipped.length === 2);
  check('it says why each was passed over',
    pick.skipped[0].state === 'clash' && pick.skipped[1].state === 'short');
  check('nothing playable answers -1',
    nextPlayableGame([game('a', 'b', 'c', 'x')], new Set(['x']), new Set()).index === -1);
  check('an empty queue answers -1', nextPlayableGame([], new Set(), new Set()).index === -1);
}

// ── takeNextGame ──
{
  const base = () => ({
    numCourts: 2,
    courtNumbers: [1, 2],
    courtRounds: [0, 0],
    courtLive: [1000, 2000],
    wentHome: [],
    rounds: [{ label: 'Live', courts: [game('a', 'b', 'c', 'd'), game('e', 'f', 'g', 'h')] }],
    queue: [game('m', 'n', 'o', 'p'), game('q', 'r', 's', 't')],
    played: [],
  });

  const r = takeNextGame(base(), 0, 9000);
  check('the game goes on the asking court',
    JSON.stringify(r.rounds[0].courts[0]) === JSON.stringify(game('m', 'n', 'o', 'p')));
  check('the other court is untouched',
    JSON.stringify(r.rounds[0].courts[1]) === JSON.stringify(game('e', 'f', 'g', 'h')));
  check('the game leaves the queue', r.queue.length === 1);
  check('the finished game is recorded', r.played.length === 1 && r.played[0].court === 0);
  check('the record carries the real start and end',
    r.played[0].startedAt === 1000 && r.played[0].endedAt === 9000);
  check('the new game restarts that court clock only',
    r.courtLive[0] === 9000 && r.courtLive[1] === 2000);
  check('the board stays one row', r.rounds.length === 1);
  check('every court points at the live row',
    JSON.stringify(r.courtRounds) === '[0,0]');

  // The four walking off must not block the game replacing them.
  const s = base();
  s.queue = [game('a', 'b', 'c', 'd')];
  const own = takeNextGame(s, 0, 9000);
  check('a court is not blocked by its own outgoing players',
    own && !own.empty && own.queue.length === 0);

  // ...but the OTHER court's players are a clash, and the game stays put.
  const t = base();
  t.queue = [game('e', 'f', 'g', 'h'), game('m', 'n', 'o', 'p')];
  const skip = takeNextGame(t, 0, 9000);
  check('a game clashing with another court is skipped',
    JSON.stringify(skip.rounds[0].courts[0]) === JSON.stringify(game('m', 'n', 'o', 'p')));
  check('the skipped game keeps its place in the queue',
    skip.queue.length === 1 && skip.queue[0].team1[0] === 'e');
  check('the skip is reported', skip.skipped.length === 1 && skip.skipped[0].state === 'clash');

  // A court with nothing on it records nothing.
  const u = base();
  u.rounds = [{ label: 'Live', courts: [EMPTY(), game('e', 'f', 'g', 'h')] }];
  const fresh = takeNextGame(u, 0, 9000);
  check('an empty court records no finished game', fresh.played.length === 0);

  // Nothing playable at all.
  const v = base();
  v.queue = [game('e', 'f', 'g', 'h')];
  const none = takeNextGame(v, 0, 9000);
  check('nothing playable answers empty', none && none.empty === true);
  check('and says what it looked at', none.skipped.length === 1);

  check('an out-of-range court is refused', takeNextGame(base(), 5, 9000) === null);
}

// ── an old multi-round night still collapses safely ──
{
  // Three rounds, two courts, court 0 on round 2 and court 1 still on round 1 —
  // exactly the uneven state the old model produced and this change exists for.
  const old = {
    numCourts: 2,
    courtRounds: [2, 1],
    courtLive: [0, 0],
    wentHome: [],
    rounds: [
      { label: 'Round 1', courts: [game('a', 'b', 'c', 'd'), game('e', 'f', 'g', 'h')] },
      { label: 'Round 2', courts: [game('i', 'j', 'k', 'l'), game('m', 'n', 'o', 'p')] },
      { label: 'Round 3', courts: [game('q', 'r', 's', 't'), game('u', 'v', 'w', 'x')] },
    ],
    queue: [game('1', '2', '3', '4')],
    played: [],
  };

  const row = liveBoardRow(old.rounds, old.courtRounds, 2);
  check('the live row is read per court, not from row 0',
    JSON.stringify(row.courts[0]) === JSON.stringify(game('q', 'r', 's', 't'))
    && JSON.stringify(row.courts[1]) === JSON.stringify(game('m', 'n', 'o', 'p')));

  const hist = historicGamesOf(old.rounds, old.courtRounds, 2);
  check('the games already played are recovered', hist.length === 3);
  check('each recovered game keeps its court',
    hist.filter(g => g.court === 0).length === 2 && hist.filter(g => g.court === 1).length === 1);
  check('a recovered game has no invented clock',
    hist.every(g => g.startedAt === 0 && g.endedAt === 0));
  check('a one-row night has nothing to recover',
    historicGamesOf([{ label: 'Live', courts: [game('a', 'b', 'c', 'd')] }], [0], 1).length === 0);

  const moved = takeNextGame(old, 1, 9000);
  check('advancing an old night folds its history in, and does not lose it',
    moved.played.length === 4);
  check('the game that was on the court is among them',
    moved.played.some(g => g.court === 1 && g.team1[0] === 'm'));
  check('and it collapses to one row', moved.rounds.length === 1);
  check('court 0 keeps the game it was actually on',
    JSON.stringify(moved.rounds[0].courts[0]) === JSON.stringify(game('q', 'r', 's', 't')));
}

// ── putGameBack ──
{
  const src = {
    numCourts: 2,
    courtRounds: [0, 0],
    courtLive: [9000, 2000],
    rounds: [{ label: 'Live', courts: [game('m', 'n', 'o', 'p'), game('e', 'f', 'g', 'h')] }],
    queue: [game('q', 'r', 's', 't')],
    played: [{ id: 'x1', court: 0, team1: ['a', 'b'], team2: ['c', 'd'], startedAt: 1000, endedAt: 9000 }],
  };
  const back = putGameBack(src, 0);
  check('the current game returns to the FRONT of the queue',
    back.queue.length === 2 && back.queue[0].team1[0] === 'm');
  check('the previous game comes back onto the court',
    JSON.stringify(back.rounds[0].courts[0]) === JSON.stringify(game('a', 'b', 'c', 'd')));
  check('it leaves the record', back.played.length === 0);
  check('the clock goes back to when that game started', back.courtLive[0] === 1000);
  check('the other court is untouched',
    JSON.stringify(back.rounds[0].courts[1]) === JSON.stringify(game('e', 'f', 'g', 'h')));

  // Undo on a court with no earlier game leaves it empty rather than inventing one.
  const first = putGameBack({
    numCourts: 1, courtRounds: [0], courtLive: [9000],
    rounds: [{ label: 'Live', courts: [game('m', 'n', 'o', 'p')] }], queue: [], played: [],
  }, 0);
  check('undoing the first game of the night empties the court',
    !gameIds(first.rounds[0].courts[0]).some(Boolean) && first.queue.length === 1);
  check('and stops its clock', first.courtLive[0] === 0);

  check('undo on an empty court does nothing', putGameBack({
    numCourts: 1, courtRounds: [0], courtLive: [0],
    rounds: [{ label: 'Live', courts: [EMPTY()] }], queue: [], played: [],
  }, 0) === null);
}

// ── takeNextGame then putGameBack is a round trip ──
{
  const before = {
    numCourts: 2, courtRounds: [0, 0], courtLive: [1000, 2000], wentHome: [],
    rounds: [{ label: 'Live', courts: [game('a', 'b', 'c', 'd'), game('e', 'f', 'g', 'h')] }],
    queue: [game('m', 'n', 'o', 'p'), game('q', 'r', 's', 't')],
    played: [],
  };
  const took = takeNextGame(before, 0, 9000);
  const undone = putGameBack({ ...before, ...took }, 0);
  check('undo restores the court exactly',
    JSON.stringify(undone.rounds[0].courts[0]) === JSON.stringify(game('a', 'b', 'c', 'd')));
  check('undo restores the queue exactly',
    JSON.stringify(undone.queue.map(g => g.team1[0])) === JSON.stringify(['m', 'q']));
  check('undo restores the clock', undone.courtLive[0] === 1000);
  check('undo leaves nothing in the record', undone.played.length === 0);
}

// ── courtIsFree ──
{
  const rounds = [{ label: 'Live', courts: [game('a', 'b', 'c', 'd'), EMPTY()] }];
  check('a court with a game on it is not free', courtIsFree(rounds, [0, 0], 0) === false);
  check('an empty court is free', courtIsFree(rounds, [0, 0], 1) === true);
}

// ── waitMinutes ──
{
  const NOW = 60 * 60 * 1000; // an hour into the epoch, for easy arithmetic
  const min = (m) => NOW - m * 60000;
  const played = [
    { court: 0, team1: ['a', 'b'], team2: ['c', 'd'], startedAt: min(50), endedAt: min(40) },
    { court: 0, team1: ['a', 'e'], team2: ['f', 'g'], startedAt: min(38), endedAt: min(20) },
  ];
  const players = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'z' }, { id: 'live1' }];
  const w = waitMinutes(played, players, new Set(['live1']), NOW);
  check('a player on a court is not waiting', w.live1 === 0);
  check('the wait runs from their LAST game, not their first', w.a === 20);
  check('somebody who came off earlier has waited longer', w.b === 40);
  check('somebody who has not played is measured from the start of the night',
    w.z === 50);
  check('never-played therefore outranks everyone who has played', w.z > w.b);
  check('before the first game everybody reads zero',
    waitMinutes([], players, new Set(), NOW).a === 0);
  // A game still running has no endedAt and must not count as a finish.
  check('a game still in progress does not end anybody\'s wait',
    waitMinutes([{ court: 0, team1: ['a', 'b'], team2: ['c', 'd'], startedAt: min(10), endedAt: 0 }],
      [{ id: 'a' }], new Set(), NOW).a === 10);
}

// ── playedGameCounts ──
{
  const counts = playedGameCounts([
    { team1: ['a', 'b'], team2: ['c', 'd'] },
    { team1: ['a', 'e'], team2: ['f', 'g'] },
  ]);
  check('games tonight are counted per player', counts.a === 2 && counts.b === 1);
  check('a player with no games is absent', counts.zzz === undefined);
}

// ── the redness ramp ──
{
  check('a fresh player has no tint', waitHeatLevel(0) === 0 && waitHeatLevel(BAND - 1) === 0);
  check('the ramp starts at one band', waitHeatLevel(BAND) === 1);
  check('and deepens by band', waitHeatLevel(BAND * 3) === Math.min(CAP, 3));
  check('and caps', waitHeatLevel(BAND * 99) === CAP);
  check('junk reads as no tint', waitHeatLevel('nope') === 0);
  check('the top band is open ended', waitBandLabel(CAP) === `${CAP * BAND}+ MIN`);
  check('a middle band names its range', waitBandLabel(1) === `${BAND}–${BAND * 2 - 1} MIN`);
}

// ── report ──
console.log('\ntest-game-queue — the shared queue, the skip rule and the clock\n');
const groups = [
  'the four ids and who is on a court',
  'a game is ready, short, gone or clashing',
  'the queue hands out the first game that can start',
  'taking a game moves it onto the court and records the last one',
  'an old multi-round night collapses without losing its history',
  'undo puts the game back and the court back',
  'waiting is measured in minutes, from the last game that ended',
];
if (!failures.length) {
  for (const g of groups) console.log(`  PASS  ${g}`);
  console.log('\nRESULT: PASS — game queue assertions green.');
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nRESULT: FAIL — ${failures.length} assertion(s) red.`);
process.exit(1);
