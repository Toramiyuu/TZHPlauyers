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
 * Now every court has its OWN lane, one game deep: the court card's "Next game"
 * view. state.queue is still one flat array, but each game carries `court` and
 * lane i is the games with court === i. "Put on court" takes the top of lane i
 * and puts it on — no scan, no skip, no refusal; a clash is REPORTED, never
 * obeyed. A lane whose court is switched off is parked, not deleted.
 * state.rounds is a one-row live board, state.played is the record, and the
 * card's "Previous" view is the last game in it for that court.
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
 *   oneNextPerCourt(queue)             -> only the top game of every lane
 *   withNextGame(queue, court, game)   -> that court's next game set (or, with
 *                                         nobody in it, removed)
 *   setGameSeat(game, team, k, id)     -> one seat set; never the same person twice
 *   swapGameSeats(game, a, b)          -> two seats of one game swapped
 *   lastPlayedIndex(played, court)     -> the court's Previous game in the record
 *   waitMinutes(played, players, live, now) -> { id: whole minutes waiting }
 *   playedGameCounts(played)           -> { id: games tonight }
 *   waitHeatLevel(min) / waitBandLabel(level)
 *   liveBoardRow(rounds, cr, n)        -> the one-row board, built per court
 *   historicGamesOf(rounds, cr, n)     -> an old multi-round night's games
 *   courtIsFree(rounds, cr, i)
 *   takeNextGame(state, courtIdx, at)  -> { rounds, queue, played, courtRounds,
 *                                           courtLive, took, finished, skipped }
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

// takeNextGame calls setCourtLiveAt, which calls normalizeCourtLive,
// so the clock helpers load alongside them — same pattern as test-court-games.
const NAMES = [
  'normalizeCourtLive', 'setCourtLiveAt', 'normalizeCourtWinner', 'setCourtWinnerAt', 'winLossIn',
  'normalizeCourtStatus', 'setCourtStatusAt', 'normalizeEndingSoon', 'clearEndingSoonForCourt',
  'gameIds', 'liveCourtIds', 'gameReadiness',
  'queueCourtOf', 'laneOf', 'nextInLane', 'oneNextPerCourt', 'withNextGame',
  'setGameSeat', 'swapGameSeats', 'seatsOf', 'lastPlayedIndex',
  'waitMinutes', 'playedGameCounts', 'roundsRested', 'restBand', 'restBandLabel', 'restHeatClass',
  'liveBoardRow', 'historicGamesOf', 'courtIsFree', 'lastEndOnCourt', 'takeNextGame',
];
const srcs = NAMES.map(n => {
  const s = extractFn(n, html);
  if (!s) { console.error(`FAIL: ${n}() not found in public/index.html`); process.exit(1); }
  return s;
});
// The cap is a top-level `const`, so extractFn cannot see it. Reading it out of
// the source keeps this test honest: retune it in index.html and the
// expectations below follow rather than silently diverging.
const capMatch = html.match(/const REST_MAX_BAND\s*=\s*(\d+)/);
const dangerMatch = html.match(/const REST_DANGER\s*=\s*(\d+)/);
if (!capMatch || !dangerMatch) {
  console.error('FAIL: REST_MAX_BAND / REST_DANGER not found in public/index.html');
  process.exit(1);
}
const CAP = Number(capMatch[1]);
const DANGER = Number(dangerMatch[1]);
const statusConst = (html.match(/const COURT_STATUSES = \[[^\]]*\];/) || [''])[0];
const api = new Function(
  `${statusConst}\nconst REST_MAX_BAND = ${CAP}; const REST_DANGER = ${DANGER};\n`
  + `${srcs.join('\n')}; return { ${NAMES.join(', ')} };`
)();
const {
  gameIds, liveCourtIds, gameReadiness, waitMinutes,
  queueCourtOf, laneOf, nextInLane, oneNextPerCourt, withNextGame, setGameSeat, swapGameSeats,
  lastPlayedIndex,
  playedGameCounts, roundsRested, restBand, restBandLabel, restHeatClass, liveBoardRow, historicGamesOf,
  courtIsFree, takeNextGame, winLossIn,
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

}

// ── one next game per court ──
// The card's Next game view IS the lane now, so a lane is one game deep.
{
  const at = (c, a, b, x, y) => Object.assign(game(a, b, x, y), { court: c });
  const old = [at(0, 'a', 'b', 'c', 'd'), at(1, 'e', 'f', 'g', 'h'), at(0, 'i', 'j', 'k', 'l'), at(5, 'm', 'n', 'o', 'p'), at(5, 'q', 'r', 's', 't')];
  const one = oneNextPerCourt(old);
  check('a night saved with whole queues keeps the top game of each lane',
    one.map(g => g.team1[0]).join(',') === 'a,e,m');
  check('a parked lane is trimmed, not dropped', one.some(g => g.court === 5));
  check('oneNextPerCourt survives junk', oneNextPerCourt(null).length === 0);

  const set = withNextGame(old, 0, { id: 'n0', team1: ['z', ''], team2: ['', ''] });
  check('setting a next game replaces that court\'s game in place',
    laneOf(set, 0).length === 1 && laneOf(set, 0)[0].game.team1.join() === 'z,' && set[0].id === 'n0');
  check('and trims every other lane to one game too', set.length === 3);
  check('the court is stamped on the game', queueCourtOf(laneOf(set, 0)[0].game) === 0);
  const added = withNextGame([at(1, 'e', 'f', 'g', 'h')], 2, { id: 'n2', team1: ['z', 'y'], team2: ['x', 'w'] });
  check('a court with nothing planned gets its game added',
    added.length === 2 && laneOf(added, 2)[0].game.id === 'n2');
  const kept = withNextGame(old, 1, { team1: ['z', 'f'], team2: ['g', 'h'] });
  check('an edit with no id keeps the game\'s own id', laneOf(kept, 1)[0].game.id === undefined || laneOf(kept, 1)[0].game.id === '');
  const cleared = withNextGame(old, 0, { id: 'n0', team1: ['', ''], team2: ['', ''] });
  check('emptying every seat removes the next game rather than saving four blanks',
    laneOf(cleared, 0).length === 0 && laneOf(cleared, 1).length === 1);
  check('clearing a court with nothing planned changes nothing else',
    withNextGame(old, 3, EMPTY()).length === 3);

  const g = { id: 'g', court: 1, team1: ['a', 'b'], team2: ['c', ''], startedAt: 5, winner: 'red' };
  const placed = setGameSeat(g, 'team2', 1, 'a');
  check('a name moved into an empty seat of its own game leaves its old one',
    placed.team1.join() === ',b' && placed.team2.join() === 'c,a');
  const traded = setGameSeat(g, 'team2', 0, 'a');
  check('a name moved onto a taken seat of its own game trades places — nobody drops out',
    traded.team1.join() === 'c,b' && traded.team2.join() === 'a,');
  check('picking the person already in that seat changes nothing',
    JSON.stringify(setGameSeat(g, 'team1', 0, 'a').team1) === '["a","b"]');
  check('everything else about the game rides through',
    placed.id === 'g' && placed.court === 1 && placed.startedAt === 5 && placed.winner === 'red');
  check('setting a seat never edits the game it was given', g.team1.join() === 'a,b');
  check('an empty id empties just that seat', setGameSeat(g, 'team1', 0, '').team1.join() === ',b');
  check('a short game is padded to two seats a side',
    setGameSeat({ team1: ['a'] }, 'team2', 0, 'b').team2.join() === 'b,');
  check('a junk seat changes nothing', JSON.stringify(setGameSeat(g, 'team3', 0, 'z').team1) === '["a","b"]');
  const sw = swapGameSeats(g, { team: 'team1', k: 0 }, { team: 'team2', k: 1 });
  check('two seats of one game swap, empties included', sw.team1.join() === ',b' && sw.team2.join() === 'c,a');

  const played = [at(0, 'a', 'b', 'c', 'd'), at(1, 'e', 'f', 'g', 'h'), at(0, 'i', 'j', 'k', 'l')];
  check('Previous is the LAST game finished on that court', lastPlayedIndex(played, 0) === 2);
  check('each court has its own Previous', lastPlayedIndex(played, 1) === 1);
  check('a court with nothing finished has no Previous', lastPlayedIndex(played, 2) === -1);
  check('a record from before courts were stamped belongs to court 0',
    lastPlayedIndex([game('a', 'b', 'c', 'd')], 0) === 0 && lastPlayedIndex(null, 0) === -1);
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
  // The winner the admin called rides into the record and clears for the new game.
  const w = takeNextGame(Object.assign(base(), { courtWinner: ['blue', 'red'] }), 0, 9000);
  check('a called winner is written into the finished game', w.played[0].winner === 'blue');
  check('and cleared for the game that goes on, other courts untouched',
    JSON.stringify(w.courtWinner) === JSON.stringify(['', 'red']));
  check('no winner called means no winner field', !('winner' in r.played[0]));
  const night = [
    { team1: ['a', 'b'], team2: ['c', 'd'], winner: 'red' },
    { team1: ['c', 'a'], team2: ['e', 'f'], winner: 'blue' },
    { team1: ['a', 'e'], team2: ['g', 'h'] },             // nobody called it
  ];
  const wa = winLossIn(night, 'a'), wc = winLossIn(night, 'c');
  check('won and lost follow the side the winner was on', wa.won === 1 && wa.lost === 1 && wc.won === 0 && wc.lost === 2);
  check('a game with no winner called is neither won nor lost', winLossIn(night, 'g').won === 0 && winLossIn(night, 'g').lost === 0);
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

// ── rounds rested, on the court they last played on ──
{
  const g = (court, t1, t2, endedAt) => ({ court, team1: t1, team2: t2, startedAt: 1, endedAt });
  // a,b,c,d play court 0 round 1; court 0 then runs round 2 (ends) and round 3 (live).
  // Court 1 games never count for them.
  const played = [
    g(0, ['a', 'b'], ['c', 'd'], 100),
    g(1, ['e', 'f'], ['g', 'h'], 150),
    g(0, ['i', 'j'], ['k', 'l'], 200),
  ];
  const ps = ['a', 'e', 'i', 'z', 'm'].map(id => ({ id }));
  const busyBoth = roundsRested(played, ps, new Set(['m']), new Set([0, 1]));
  check('round 3 live on their court = rested 2', busyBoth.a === 2);
  check('only their own court counts', busyBoth.e === 1);
  check('court started its next game = rested 1', busyBoth.i === 1);
  check('nobody on a court is resting', busyBoth.m === 0);
  check('not played yet reads null', busyBoth.z === null);
  check('an empty court adds nothing', roundsRested(played, ps, new Set(), new Set()).i === 0);
}

// ── the bench groups, and red from 3 ──
{
  check('zero is its own group', restBand(0) === 0);
  check('and caps', restBand(99) === CAP);
  check('junk reads as group zero', restBand('nope') === 0);
  check('group zero says they just played', restBandLabel(0) === 'JUST PLAYED');
  check('one round is singular', restBandLabel(1) === 'RESTED 1 ROUND');
  check('two rounds is plural', restBandLabel(2) === 'RESTED 2 ROUNDS');
  check('the top group is open ended', restBandLabel(CAP) === `RESTED ${CAP}+ ROUNDS`);
  check('below the danger line is not red', restHeatClass(DANGER - 1) === '');
  check('the danger line is red', restHeatClass(DANGER) !== '');
}

// ── report ──
console.log('\ntest-game-queue — one next game per court, and the clock\n');
const groups = [
  'the four ids and who is on a court',
  'a game is ready, short, gone or clashing — as advice, not a veto',
  'each court owns a lane, one game deep: old queues keep only their top game',
  'next and previous games are edited seat by seat, never one person twice',
  'a court takes its own next game and never skips it',
  'an old multi-round night collapses without losing its history',
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
