#!/usr/bin/env node
/*
 * test-game-queue.js — guard for the per-court game queue.
 *
 * The night used to be planned in ROUNDS: one row of state.rounds held every
 * court at once. Court 2 goes to deuce and takes twenty minutes while 3 and 4
 * finish in eight, so 3 and 4 advance without it and the people on the slow
 * court quietly play fewer games all night.
 *
 * That became ONE shared queue belonging to no court, which fixed the fairness
 * and broke the usefulness: with every court drawing from one list, most queued
 * games held somebody still mid-match, so "Next game" reported eight skips and
 * put nothing on.
 *
 * Now every court has its OWN lane. state.queue is still one flat array, but
 * each game carries `court` and lane i is the games with court === i, in order.
 * "Next game" on court i takes the top of lane i and puts it on — no scan, no
 * skip, no refusal; a clash is REPORTED, never obeyed. A lane whose court is
 * switched off is parked, not deleted. state.rounds is a one-row live board,
 * state.played is the record.
 *
 * PURE helpers in public/index.html:
 *
 *   gameIds(game)                      -> the four ids in seat order
 *   liveCourtIds(rounds, cr, n, except)-> ids on a court now; `except` leaves
 *                                         out the court that is asking, whose
 *                                         four are walking off
 *   gameReadiness(game, live, gone)    -> { state:'ready'|'short'|'gone'|'clash', ids }
 *                                         ADVICE now: nothing acts on it
 *   queueCourtOf(game)                 -> the court a game is planned for
 *   laneOf(queue, court)               -> [{ index, game }] for one court
 *   nextInLane(queue, court)           -> { index, game } — the top of a lane
 *   unshiftIntoLane(queue, court, g)   -> g at the FRONT of that lane (undo)
 *   moveWithinLane(queue, index, d)    -> reorder inside one lane only
 *   parkedLanes(queue, numCourts)      -> [{ court, count }] for courts now off
 *   queueRowState(game, pos, ctx)      -> what a row SAYS, which is not what is
 *                                         true of it: a clash only matters for
 *                                         the game about to go on
 *   queueFromLaneOrder(queue, orders)  -> the queue rebuilt from a drag: lanes
 *                                         in their new DOM order, each game
 *                                         re-stamped with the lane it landed in
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
  'gameIds', 'liveCourtIds', 'gameReadiness',
  'queueCourtOf', 'laneOf', 'nextInLane', 'unshiftIntoLane', 'moveWithinLane', 'parkedLanes',
  'queueRowState', 'queueFromLaneOrder',
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
  gameIds, liveCourtIds, gameReadiness, waitMinutes,
  queueCourtOf, laneOf, nextInLane, unshiftIntoLane, moveWithinLane, parkedLanes, queueRowState,
  queueFromLaneOrder,
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

// ── lanes ──
{
  const onCourt = (c, a, b, x, y) => Object.assign(game(a, b, x, y), { court: c });
  const queue = [
    onCourt(0, 'a', 'b', 'c', 'd'),
    onCourt(1, 'e', 'f', 'g', 'h'),
    onCourt(0, 'i', 'j', 'k', 'l'),
    onCourt(2, 'm', 'n', 'o', 'p'),
  ];

  check('a game with no court belongs to court 0 — the one every venue has',
    queueCourtOf(game('a', 'b', 'c', 'd')) === 0 && queueCourtOf(null) === 0);
  check('a junk court reads as 0, never as NaN',
    queueCourtOf({ court: 'left one' }) === 0 && queueCourtOf({ court: -3 }) === 0);
  check('a real court index comes through', queueCourtOf({ court: 2 }) === 2);

  const lane0 = laneOf(queue, 0);
  check('a lane holds only its own court\'s games, in order',
    lane0.length === 2 && lane0[0].game.team1[0] === 'a' && lane0[1].game.team1[0] === 'i');
  check('a lane carries each game\'s index in the FLAT queue',
    lane0[0].index === 0 && lane0[1].index === 2);
  check('a court with nothing queued has an empty lane', laneOf(queue, 3).length === 0);
  check('laneOf survives junk', laneOf(null, 0).length === 0 && laneOf(queue, 'x').length === 0);

  // THE RULE: a court takes the top of its own lane. It does not scan, it does
  // not skip, and a clash with another court is not its business.
  check('nextInLane takes the top of that court\'s lane',
    nextInLane(queue, 0).index === 0 && nextInLane(queue, 1).index === 1);
  check('an empty lane answers -1', nextInLane(queue, 3).index === -1);
  check('a clash does NOT make a lane skip its own top game',
    nextInLane([onCourt(0, 'a', 'b', 'c', 'x'), onCourt(0, 'm', 'n', 'o', 'p')], 0).game.team2[1] === 'x');
  check('a short game does not make a lane skip it either',
    nextInLane([onCourt(0, 'a', 'b', '', ''), onCourt(0, 'm', 'n', 'o', 'p')], 0).game.team2[0] === '');

  // unshiftIntoLane — what undo uses.
  const un = unshiftIntoLane(queue, 0, game('z', 'z', 'z', 'z'));
  check('a game goes to the FRONT of its own lane, not the front of the queue',
    laneOf(un, 0)[0].game.team1[0] === 'z' && un.length === 5);
  check('and it does not disturb any other lane',
    JSON.stringify(laneOf(un, 1).map(x => x.game)) === JSON.stringify(laneOf(queue, 1).map(x => x.game)));
  check('the court is stamped on the way in', queueCourtOf(laneOf(un, 0)[0].game) === 0);
  const empty = unshiftIntoLane(queue, 3, game('z', 'z', 'z', 'z'));
  check('into an empty lane it simply joins the queue',
    empty.length === 5 && queueCourtOf(empty[4]) === 3);

  // moveWithinLane — reordering must never reach across courts.
  const moved = moveWithinLane(queue, 2, -1);
  check('moving up swaps with the game above it IN THE SAME LANE',
    laneOf(moved, 0)[0].game.team1[0] === 'i' && laneOf(moved, 0)[1].game.team1[0] === 'a');
  check('the other lanes are untouched by a move',
    moved[1].team1[0] === 'e' && moved[3].team1[0] === 'm');
  check('the top of a lane cannot move up', 
    JSON.stringify(moveWithinLane(queue, 0, -1)) === JSON.stringify(queue));
  check('the bottom of a lane cannot move down',
    JSON.stringify(moveWithinLane(queue, 2, 1)) === JSON.stringify(queue));
  check('a lone game in a lane cannot move at all',
    JSON.stringify(moveWithinLane(queue, 3, -1)) === JSON.stringify(queue)
    && JSON.stringify(moveWithinLane(queue, 3, 1)) === JSON.stringify(queue));
  check('moveWithinLane survives an out-of-range index',
    JSON.stringify(moveWithinLane(queue, 99, 1)) === JSON.stringify(queue));

  // parkedLanes — switching a court off must never look like data loss.
  const parked = parkedLanes(queue, 2);
  check('games for a court that is switched off are reported, not dropped',
    parked.length === 1 && parked[0].court === 2 && parked[0].count === 1);
  check('nothing is parked while every court is on', parkedLanes(queue, 3).length === 0);
  check('parked lanes come back in court order',
    JSON.stringify(parkedLanes([...queue, onCourt(4, 'q', 'r', 's', 't')], 2).map(p => p.court)) === '[2,4]');
}

// ── dragging a row ──
// A drag can only report what the lanes look like afterwards, so the commit has
// to turn "these flat indexes, in this order, in this lane" back into a queue.
// Dropping a row in another lane IS moving it to that court — same operation.
{
  const at = (c, a, b, x, y) => Object.assign(game(a, b, x, y), { court: c });
  const q = [at(0, 'a', 'b', 'c', 'd'), at(1, 'e', 'f', 'g', 'h'), at(0, 'i', 'j', 'k', 'l')];

  const same = queueFromLaneOrder(q, [{ court: 0, indexes: [0, 2] }, { court: 1, indexes: [1] }]);
  check('a drag that changed nothing rebuilds the same queue',
    JSON.stringify(same.map(g => [g.court, g.team1[0]])) === '[[0,"a"],[0,"i"],[1,"e"]]');

  const reordered = queueFromLaneOrder(q, [{ court: 0, indexes: [2, 0] }, { court: 1, indexes: [1] }]);
  check('reordering inside a lane comes back in the new order',
    laneOf(reordered, 0).map(x => x.game.team1[0]).join(',') === 'i,a');

  const crossed = queueFromLaneOrder(q, [{ court: 0, indexes: [0] }, { court: 1, indexes: [2, 1] }]);
  check('a row dropped in another lane is re-stamped with that court',
    laneOf(crossed, 1).map(x => x.game.team1[0]).join(',') === 'i,e'
    && laneOf(crossed, 0).length === 1);
  check('and it keeps everything else about the game',
    laneOf(crossed, 1)[0].game.team2[1] === 'l');

  // The DOM only draws the lanes for courts that are switched ON. Games parked
  // on a court that is off are invisible to a drag and must survive it.
  const parkedQ = [...q, at(5, 'm', 'n', 'o', 'p')];
  const kept = queueFromLaneOrder(parkedQ, [{ court: 0, indexes: [0, 2] }, { court: 1, indexes: [1] }]);
  check('a drag never drops the games parked on a switched-off court',
    kept.length === 4 && laneOf(kept, 5).length === 1);

  check('an index named twice is only placed once',
    queueFromLaneOrder(q, [{ court: 0, indexes: [0, 0, 2] }]).length === 3);
  check('junk indexes and junk lanes are ignored, never thrown',
    queueFromLaneOrder(q, [{ court: 0, indexes: [99, 'x', null] }]).length === 3
    && queueFromLaneOrder(q, null).length === 3
    && queueFromLaneOrder(null, [{ court: 0, indexes: [0] }]).length === 0);
}

// ── what a queue row says ──
// A warning you learn to ignore is worse than no warning. The third game down a
// lane will not be played for half an hour, so telling the organiser its players
// are "on court" every time they look is noise they will train themselves past —
// and then miss the one that mattered.
{
  const ctx = { live: new Set(['x']), gone: new Set(['z']) };
  const clash = game('a', 'b', 'c', 'x');
  check('a clash is said about the game that is about to go on',
    queueRowState(clash, 0, ctx).state === 'clash');
  check('and NOT about the ones further down the lane',
    queueRowState(clash, 1, ctx).state === 'ready'
    && queueRowState(clash, 5, ctx).state === 'ready');
  check('a silenced clash names nobody either', queueRowState(clash, 1, ctx).ids.length === 0);
  // These two are wrong at any depth: nobody un-goes-home, and a game three
  // names long is still three names long when its turn comes.
  check('gone home is said at any depth',
    queueRowState(game('a', 'b', 'c', 'z'), 0, ctx).state === 'gone'
    && queueRowState(game('a', 'b', 'c', 'z'), 4, ctx).state === 'gone');
  check('short is said at any depth',
    queueRowState(game('a', 'b', '', ''), 0, ctx).state === 'short'
    && queueRowState(game('a', 'b', '', ''), 4, ctx).state === 'short');
  check('a clean game says nothing wherever it sits',
    queueRowState(game('a', 'b', 'c', 'd'), 0, ctx).state === 'ready'
    && queueRowState(game('a', 'b', 'c', 'd'), 3, ctx).state === 'ready');
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
    queue: [game('m', 'n', 'o', 'p'), game('q', 'r', 's', 't')],   // both court 0 by default
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

  // A court only ever reaches into its OWN lane.
  const lanes = base();
  lanes.queue = [
    Object.assign(game('1', '2', '3', '4'), { court: 1 }),
    Object.assign(game('5', '6', '7', '8'), { court: 0 }),
  ];
  const mine = takeNextGame(lanes, 0, 9000);
  check('a court takes from its own lane, not the top of the array',
    JSON.stringify(mine.rounds[0].courts[0]) === JSON.stringify(game('5', '6', '7', '8')));
  check('the other lane is left completely alone',
    mine.queue.length === 1 && mine.queue[0].team1[0] === '1' && mine.queue[0].court === 1);

  // The four walking off must not be reported as a clash against their own
  // replacement — they are leaving the court this game is going onto.
  const s = base();
  s.queue = [game('a', 'b', 'c', 'd')];
  const own = takeNextGame(s, 0, 9000);
  check('a court is not warned about its own outgoing players',
    own && !own.empty && own.queue.length === 0 && own.warn.state === 'ready');

  // THE CHANGE: a clash with another court is said, not obeyed.
  const t = base();
  t.queue = [game('e', 'f', 'g', 'h'), game('m', 'n', 'o', 'p')];
  const clash = takeNextGame(t, 0, 9000);
  check('a game clashing with another court STILL goes on',
    JSON.stringify(clash.rounds[0].courts[0]) === JSON.stringify(game('e', 'f', 'g', 'h')));
  check('it leaves the queue like any other game',
    clash.queue.length === 1 && clash.queue[0].team1[0] === 'm');
  check('and the clash is reported so the organiser can swap a name',
    clash.warn.state === 'clash' && clash.warn.ids.join(',') === 'e,f,g,h');

  // A game short of names is not refused either. The organiser queued it.
  const sh = base();
  sh.queue = [game('m', 'n', '', '')];
  const short = takeNextGame(sh, 0, 9000);
  check('a short game goes on and says so',
    !short.empty && short.warn.state === 'short');

  // Someone who has gone home is worth saying out loud, and still not a veto.
  const gh = base();
  gh.queue = [game('m', 'n', 'o', 'p')];
  gh.wentHome = ['o'];
  const goneRes = takeNextGame(gh, 0, 9000);
  check('a game with someone gone home goes on and names them',
    !goneRes.empty && goneRes.warn.state === 'gone' && goneRes.warn.ids.join() === 'o');

  // A court with nothing on it records nothing.
  const u = base();
  u.rounds = [{ label: 'Live', courts: [EMPTY(), game('e', 'f', 'g', 'h')] }];
  const fresh = takeNextGame(u, 0, 9000);
  check('an empty court records no finished game', fresh.played.length === 0);

  // An empty lane is the ONLY thing that stops a court now.
  const v = base();
  v.queue = [Object.assign(game('e', 'f', 'g', 'h'), { court: 1 })];
  const none = takeNextGame(v, 0, 9000);
  check('an empty lane answers empty', none && none.empty === true);
  check('and says which court is waiting', none.court === 0);

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
    queue: [Object.assign(game('1', '2', '3', '4'), { court: 1 })],
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

  // A night saved before lanes existed has a queue with no `court` on anything,
  // so every game reads as court 0's lane. Nothing is lost and nothing has to be
  // migrated — it just all belongs to the first court until it is moved.
  check('a pre-lane queue all lands in court 0\'s lane',
    laneOf([game('a', 'b', 'c', 'd'), game('e', 'f', 'g', 'h')], 0).length === 2);

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
console.log('\ntest-game-queue — one queue per court, and the clock\n');
const groups = [
  'the four ids and who is on a court',
  'a game is ready, short, gone or clashing — as advice, not a veto',
  'a clash is only worth saying about the game that is next',
  'a drag rebuilds the queue, across lanes, without losing parked games',
  'each court owns a lane: take, reorder, undo and park stay inside it',
  'a court takes its own next game and never skips it',
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
