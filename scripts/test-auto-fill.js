#!/usr/bin/env node
/* test-auto-fill — filling the empty seats in one queued game with whoever has
 * waited longest, genuinely empty hand-added games, and dragging a name from
 * one seat to another.
 *
 * The "Generate" button re-derives its own rotation from scratch, so it cannot
 * know who walked in late or who has been sitting on the bench for half an hour
 * of a night that was then hand-edited. What an organiser actually does is
 * arrange one game by hand and want the rest of its seats filled with whoever
 * has waited longest. That is a per-GAME button, and it must never touch a seat
 * that already has someone in it.
 *
 * It used to be a per-ROUND button, filling four courts at once. Rounds are
 * gone: a game is queued on its own now and gets a court only when one frees
 * up, so the fill is one game at a time and has to leave out anybody already
 * spoken for by a game ahead of it in the queue.
 *
 *   Matchmaking.emptySlotsOf / fillRound      — public/matchmaking.js (pure)
 *   playedGameCounts / waitMinutes            — public/index.html (pure)
 *   autoFillCandidates                        — public/index.html (pure-ish)
 *   autoFillQueueGame / addQueueGame          — public/index.html (DOM + write)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const M = require('../public/matchmaking.js');

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
const load = (name, extra) => new Function(`${extra || ''}${extractFn(name, html)}; return ${name};`)();

console.log('\ntest-auto-fill — fill this round\'s blanks with whoever has waited longest\n');

const court = (a, b, c, d) => ({ team1: [a, b], team2: [c, d] });
const KNOWN = new Set(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']);
const known = (id) => KNOWN.has(id);
const flat = (ct) => [].concat(ct.team1, ct.team2);
const meta = {};
['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']
  .forEach((id, i) => { meta[id] = { level: 3 + (i % 5) * 0.5, girl: false, mixed: false }; });

// ── emptySlotsOf ─────────────────────────────────────────────────────
check('a full court has no empty slots',
  M.emptySlotsOf({ courts: [court('p0', 'p1', 'p2', 'p3')] }, known).length === 0);
check('blanks are found', M.emptySlotsOf({ courts: [court('p0', '', 'p2', '')] }, known).length === 2);
check('an all-empty round reports every seat',
  M.emptySlotsOf({ courts: [court('', '', '', ''), court('', '', '', '')] }, known).length === 8);
check('slots come back court-major, Team A first', (() => {
  const s = M.emptySlotsOf({ courts: [court('p0', '', '', ''), court('', '', '', '')] }, known);
  return s[0].court === 0 && s[0].team === 'team1' && s[0].index === 1
    && s[1].court === 0 && s[1].team === 'team2' && s[2].court === 0 && s[3].court === 1;
})());
check('an id nobody knows counts as empty (a player unticked for the night)',
  M.emptySlotsOf({ courts: [court('p0', 'ghost', 'p2', 'p3')] }, known).length === 1);
check('a missing/junk round is no slots', M.emptySlotsOf(null, known).length === 0);

// ── fillRound: hand-placed players are untouchable ───────────────────
const half = { courts: [court('p0', 'p1', 'p2', 'p3'), court('p4', '', '', '')] };
const r1 = M.fillRound(half, ['p5', 'p6', 'p7', 'p8'], meta, known);
check('a hand-arranged court survives untouched',
  JSON.stringify(r1.courts[0]) === JSON.stringify(court('p0', 'p1', 'p2', 'p3')));
check('the hand-placed player on the part-filled court stays in his seat', r1.courts[1].team1[0] === 'p4');
check('the three blanks are filled', r1.filled === 3 && r1.short === 0);
check('exactly the top-3 candidates went in',
  ['p5', 'p6', 'p7'].every(id => flat(r1.courts[1]).includes(id)) && !flat(r1.courts[1]).includes('p8'));
check('the source round is never mutated', half.courts[1].team1[1] === '');

// ── who plays is strictly the candidate order ────────────────────────
const blank2 = { courts: [court('', '', '', '')] };
const order = ['p9', 'p3', 'p7', 'p0', 'p1', 'p2'];
const r2 = M.fillRound(blank2, order, meta, known);
check('the first four candidates play, and only those four',
  flat(r2.courts[0]).slice().sort().join() === ['p9', 'p3', 'p7', 'p0'].sort().join());
check('a better-balanced court is never bought with someone else\'s turn',
  !flat(r2.courts[0]).includes('p1') && !flat(r2.courts[0]).includes('p2'));

// ── where they go balances the two team sums ─────────────────────────
const lv = { a: { level: 7 }, b: { level: 6 }, c: { level: 2 }, d: { level: 1 } };
const r3 = M.fillRound({ courts: [court('', '', '', '')] }, ['a', 'b', 'c', 'd'], lv, () => true);
const bal = M.courtBalanceInfo(r3.courts[0], lv);
check('a 7/6/2/1 court is split 7+1 v 6+2, not 7+6 v 2+1', bal.gap <= 1e-9);
check('the level range is spread across courts, not stacked on one', (() => {
  const two = M.fillRound({ courts: [court('', '', '', ''), court('', '', '', '')] },
    ['h1', 'h2', 'h3', 'h4', 'l1', 'l2', 'l3', 'l4'],
    { h1: { level: 7 }, h2: { level: 7 }, h3: { level: 6.5 }, h4: { level: 6.5 },
      l1: { level: 1 }, l2: { level: 1 }, l3: { level: 1.5 }, l4: { level: 1.5 } }, () => true);
  // Both courts must contain some of the strong group — the failure this guards
  // against is court 1 getting all four 7s and court 2 all four 1s.
  const strong = (ct) => flat(ct).filter(id => id[0] === 'h').length;
  return strong(two.courts[0]) > 0 && strong(two.courts[1]) > 0;
})());

// ── never duplicates, never loses anyone ─────────────────────────────
const r4 = M.fillRound({ courts: [court('p0', '', '', '')] }, ['p0', 'p1', 'p2', 'p3'], meta, known);
check('a candidate already on the court is skipped, not placed twice',
  flat(r4.courts[0]).filter(id => id === 'p0').length === 1);
check('and the seat goes to the next candidate instead', r4.filled === 3);
const r5 = M.fillRound({ courts: [court('', '', '', '')] }, ['p1', 'p1', 'p2', 'p3', 'p4'], meta, known);
check('a duplicated candidate is only placed once',
  flat(r5.courts[0]).filter(id => id === 'p1').length === 1);
check('no slot is ever left holding a duplicate',
  new Set(flat(r5.courts[0])).size === 4);

// ── running out of people ────────────────────────────────────────────
const r6 = M.fillRound({ courts: [court('', '', '', '')] }, ['p1', 'p2'], meta, known);
check('a short pool fills what it can', r6.filled === 2);
check('and reports what it could not', r6.short === 2);
check('the unfilled seats stay empty rather than repeating someone',
  flat(r6.courts[0]).filter(id => !id).length === 2);
const r7 = M.fillRound({ courts: [court('', '', '', '')] }, [], meta, known);
check('an empty pool places nobody', r7.filled === 0 && r7.short === 4);
check('junk inputs never throw', M.fillRound(null, null, null, null).filled === 0);

// ── placed[] reports where everyone landed ───────────────────────────
check('placed carries the seat', r1.placed.every(s => s.court === 1 && ['team1', 'team2'].includes(s.team) && s.index >= 0));
check('placed has one entry per filled slot', r1.placed.length === r1.filled);

// ── permutations is only ever asked for tiny lists ───────────────────
check('permutations of 4 is 24', M.permutations([1, 2, 3, 4]).length === 24);
check('permutations of nothing is one empty ordering', M.permutations([]).length === 1);

// ── playedGameCounts ─────────────────────────────────────────────────
// gamesPlayedUpTo(rounds, upto) counted a player's games in the rounds BEFORE
// the one being filled. There is no "before this round" any more: a queued game
// has no position in a shared timeline, so games are counted over the whole
// night's record instead.
const playedGameCounts = load('playedGameCounts', extractFn('gameIds', html) + ';');
{
  const played = [
    { court: 0, team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
    { court: 0, team1: ['p0', 'p1'], team2: ['p4', 'p5'] },
  ];
  check('counts every game a player has had tonight', playedGameCounts(played).p0 === 2);
  check('somebody who has not played is absent', playedGameCounts(played).p6 === undefined);
  check('an empty record counts nothing', Object.keys(playedGameCounts([])).length === 0);
  check('junk never throws', Object.keys(playedGameCounts(null)).length === 0);
  check('empty seats are not players',
    playedGameCounts([{ team1: ['p0', ''], team2: ['', ''] }]).p0 === 1
    && playedGameCounts([{ team1: ['p0', ''], team2: ['', ''] }])[''] === undefined);
}

// ── autoFillCandidates: longest wait first, gone-home out ────────────
// The ranking is the same idea it always was — longest wait, then fewest games,
// then name — but the wait is real minutes since that player's game ended
// rather than a count of rounds, and it no longer takes a round index because
// there are no rounds to index.
const NOW = 3600000;
const mins = (m) => NOW - m * 60000;
function candidatesWith(stateObj) {
  const deps = `let state = ${JSON.stringify(stateObj)};`
    + `const Date = { now: () => ${NOW} };`
    + extractFn('normalizeWentHome', html) + ';'
    + 'function wentHomeSet(){return new Set(normalizeWentHome(state.wentHome, state.players));}'
    + 'function getCourtRounds(){return new Array(state.numCourts||1).fill(0);}'
    + extractFn('gameIds', html) + ';'
    + extractFn('liveCourtIds', html) + ';'
    + extractFn('waitMinutes', html) + ';'
    + extractFn('playedGameCounts', html) + ';';
  return load('autoFillCandidates', deps)();
}
const night = {
  numCourts: 1,
  players: [
    { id: 'p0', name: 'Alice' }, { id: 'p1', name: 'Bob' }, { id: 'p2', name: 'Cara' },
    { id: 'p3', name: 'Dan' }, { id: 'p4', name: 'Eve' }, { id: 'p5', name: 'Finn' },
    { id: 'p6', name: 'Gus' },
  ],
  // The night started 40 minutes ago. p6 has never played: a late arrival who
  // has been standing there all evening.
  rounds: [{ label: 'Live', courts: [{ team1: ['', ''], team2: ['', ''] }] }],
  played: [
    { court: 0, team1: ['p0', 'p1'], team2: ['p2', 'p3'], startedAt: mins(40), endedAt: mins(25) },
    { court: 0, team1: ['p0', 'p1'], team2: ['p4', 'p5'], startedAt: mins(24), endedAt: mins(5) },
  ],
  wentHome: [],
};
const cand = candidatesWith(night);
check('a late arrival who has never played ranks top', cand[0].id === 'p6');
check('their wait runs from the start of the night', cand[0].wait === 40);
check('whoever came off longest ago comes next',
  cand.slice(1, 3).map(c => c.id).sort().join() === ['p2', 'p3'].sort().join());
check('the wait is minutes, not a round count', cand[1].wait === 25);
check('players who just came off rank last', cand[cand.length - 1].wait === 5);
check('ties on wait break on fewest games, then name', (() => {
  const a = cand.find(c => c.id === 'p2'), b = cand.find(c => c.id === 'p3');
  return a.wait === b.wait && a.games === b.games && cand.indexOf(a) < cand.indexOf(b); // Cara before Dan
})());
check('everyone playing tonight is a candidate', cand.length === 7);

// Somebody currently ON a court is not waiting, so they rank last however long
// ago their previous game was.
{
  const playing = JSON.parse(JSON.stringify(night));
  playing.rounds = [{ label: 'Live', courts: [{ team1: ['p2', 'p3'], team2: ['p6', 'p0'] }] }];
  const c = candidatesWith(playing);
  check('a player on a court is not waiting',
    ['p2', 'p3', 'p6', 'p0'].every(id => c.find(x => x.id === id).wait === 0));
  check('and the bench still ranks above them', c[0].wait > 0);
}

const goneNight = Object.assign({}, night, { wentHome: ['p6', 'p2'] });
const cand2 = candidatesWith(goneNight);
check('a gone-home player is not a candidate at all', !cand2.some(c => c.id === 'p6' || c.id === 'p2'));
check('the rest still rank by wait', cand2[0].id === 'p3' && cand2.length === 5);
check('before the first game nobody has waited, so it is stable and deterministic', (() => {
  const fresh = Object.assign({}, night, { played: [] });
  const c0 = candidatesWith(fresh);
  return c0.every(c => c.wait === 0 && c.games === 0) && c0[0].name === 'Alice';
})());

// ── autoFillQueueGame: reads the screen, saves, reports ──────────────
const afSrc = extractFn('autoFillQueueGame', html) || '';
check('it reads the UNSAVED picks off the editor, not the last save',
  afSrc.includes('queueGameFromDom(i,'));
check('a full game is refused rather than rearranged',
  afSrc.includes('Matchmaking.emptySlotsOf(asRound, known).length') && afSrc.includes('Every seat in that game is taken'));
check('it fills through the pure helper', afSrc.includes('Matchmaking.fillRound(asRound, ranked.map(x => x.id)'));
check('candidates come from the wait ranking', afSrc.includes('autoFillCandidates()'));
// Anybody on a court, or already in an EARLIER queued game, is spoken for.
// Without this the auto-fill builds a clash by hand and guarantees one of the
// two games is skipped when a court asks for it.
check('it leaves out anyone already on a court', afSrc.includes('liveCourtIds('));
check('it leaves out anyone in an earlier queued game',
  afSrc.includes('spokenFor') && afSrc.includes('if (j < i)'));
check('the toast names who went in and how long they waited',
  afSrc.includes('Longest waits in:') && afSrc.includes('waitOf[s.id]'));
check('the wait it reports is in minutes', afSrc.includes("waitOf[s.id] || 0}m"));
check('a short fill warns instead of claiming success', afSrc.includes("res.short ? 'warn' : undefined"));
check('every queued game gets its own button', html.includes('onclick="autoFillQueueGame(${i})"'));
check('the button explains that placed players stay put',
  /Fill only the empty seats/.test(html));
check('it sits beside Save game', html.includes('class="rl-actions"') && html.includes('.rl-actions{'));

// ── a hand-added game is genuinely empty ─────────────────────────────
const addSrc = extractFn('addQueueGame', html) || '';
check('a hand-added game starts with four blank seats',
  addSrc.includes("{ id: newGameId(), team1: ['', ''], team2: ['', ''] }"));
check('it still opens the new game for editing', addSrc.includes('expandedQueue = queue.length - 1'));

// The round-era helpers must stay deleted.
for (const dead of ['gamesPlayedUpTo', 'autoFillRound', 'addEmptyRound']) {
  check(`${dead}() stays deleted`, extractFn(dead, html) === null);
}

// ── the balance chip must not invent a team sum for empty seats ──────
// courtBalanceInfo scores an empty seat as UNRATED (4.0), so before this an
// all-empty court — which is now what "+ Add Round Manually" gives you —
// displayed a confident, meaningless "8.0 v 8.0".
{
  const chip = new Function('Matchmaking', 'state', extractFn('courtChipHTML', html) + '; return courtChipHTML;');
  const st = { players: [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }] };
  const render = chip(M, st);
  const lvls = { p0: { level: 5 }, p1: { level: 3 }, p2: { level: 4 }, p3: { level: 4 } };
  check('an empty court says how many seats are open, not 8.0 v 8.0',
    render(court('', '', '', ''), lvls) === '<span class="court-balance">4 to fill</span>');
  check('a half-filled court counts the seats still open',
    render(court('p0', 'p1', '', ''), lvls).includes('2 to fill'));
  check('one blank is still a blank', render(court('p0', 'p1', 'p2', ''), lvls).includes('1 to fill'));
  check('a full court shows the real team sums', render(court('p0', 'p1', 'p2', 'p3'), lvls).includes('8.0 v 8.0'));
  check('an over-tolerance full court is still flagged amber',
    render(court('p0', 'p1', 'p2', 'p3'), { p0: { level: 7 }, p1: { level: 7 }, p2: { level: 1 }, p3: { level: 1 } })
      === '<span class="court-balance off">14.0 v 2.0 !</span>');
  check('an unticked player leaves the seat counted as open',
    render(court('p0', 'gone', 'p2', 'p3'), lvls).includes('1 to fill'));
}

// ── dragging a name between slots ────────────────────────────────────
check('a filled slot is a drag source', html.includes("draggable=\"${val ? 'true' : 'false'}\""));
check('emptying a slot stops it being draggable',
  /commitPslotValue[\s\S]{0,400}setAttribute\('draggable', val \? 'true' : 'false'\)/.test(html));
check('the drag carries its own slot id so a move can be told from a bench drop',
  html.includes("b.value + '|pslot|' + b.id"));
check('slot-to-slot swaps rather than overwrites',
  /const theirs = b\.value \|\| '';\s*commitPslotValue\(b, id\);\s*commitPslotValue\(from, theirs\);/.test(html));
check('a bench chip drop still just fills the slot', /if \(!id\) return;[\s\S]{0,520}commitPslotValue\(b, id\);\s*\}\);/.test(html));
check('dropping a slot on itself is a no-op', html.includes("parts[2] !== b.id"));
check('the drag source must really be a slot', html.includes("from.classList.contains('pslot')"));
check('the slot shows a grab cursor', html.includes('.pslot[draggable="true"]{cursor:grab}'));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? '\nRESULT: FAIL\n' : '\nRESULT: PASS — per-game auto-fill, empty hand-added games, draggable seats.\n');
process.exit(fail ? 1 : 0);
