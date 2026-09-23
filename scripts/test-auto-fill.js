#!/usr/bin/env node
/* test-auto-fill — per-round auto-fill, genuinely empty manual rounds, and
 * dragging a name from one slot to another.
 *
 * The whole-schedule "Generate Schedule" button re-derives its own rest
 * rotation from scratch, so it cannot know who walked in late or who has been
 * sitting on the bench for the last three rounds of a night that was then
 * hand-edited. What an organiser actually does is arrange one court by hand and
 * want the rest filled with whoever has waited longest. That is a per-ROUND
 * button, and it must never touch a slot that already has someone in it.
 *
 *   Matchmaking.emptySlotsOf / fillRound   — public/matchmaking.js (pure)
 *   gamesPlayedUpTo / autoFillCandidates   — public/index.html (pure)
 *   autoFillRound / addEmptyRound          — public/index.html (DOM + write)
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

// ── gamesPlayedUpTo ──────────────────────────────────────────────────
const gamesPlayedUpTo = load('gamesPlayedUpTo');
const rounds = [
  { courts: [court('p0', 'p1', 'p2', 'p3')] },
  { courts: [court('p0', 'p1', 'p4', 'p5')] },
  { courts: [court('p6', 'p7', 'p8', 'p9')] },
];
check('counts the rounds BEFORE the one being filled', gamesPlayedUpTo(rounds, 2).p0 === 2);
check('the round being filled is not counted', gamesPlayedUpTo(rounds, 2).p6 === undefined);
check('round 0 has no history', Object.keys(gamesPlayedUpTo(rounds, 0)).length === 0);
check('an upto past the end is clamped', gamesPlayedUpTo(rounds, 99).p0 === 2);
check('junk never throws', Object.keys(gamesPlayedUpTo(null, 3)).length === 0);
check('empty slots are not games', gamesPlayedUpTo([{ courts: [court('p0', '', '', '')] }], 1).p0 === 1);

// ── autoFillCandidates: longest wait first, gone-home out ────────────
function candidatesWith(stateObj, roundIndex) {
  const deps = `let state = ${JSON.stringify(stateObj)};`
    + extractFn('normalizeWentHome', html) + ';'
    + 'function wentHomeSet(){return new Set(normalizeWentHome(state.wentHome, state.players));}'
    + extractFn('computeRestStreaks', html) + ';'
    + extractFn('gamesPlayedUpTo', html) + ';';
  return load('autoFillCandidates', deps)(roundIndex);
}
const night = {
  players: [
    { id: 'p0', name: 'Alice' }, { id: 'p1', name: 'Bob' }, { id: 'p2', name: 'Cara' },
    { id: 'p3', name: 'Dan' }, { id: 'p4', name: 'Eve' }, { id: 'p5', name: 'Finn' },
    { id: 'p6', name: 'Gus' },
  ],
  // p6 never plays — a late arrival who has been standing there all night.
  rounds: [
    { courts: [court('p0', 'p1', 'p2', 'p3')] },
    { courts: [court('p0', 'p1', 'p4', 'p5')] },
    { courts: [court('', '', '', '')] },
  ],
  wentHome: [],
};
const cand = candidatesWith(night, 2);
check('a late arrival who has never played ranks top', cand[0].id === 'p6');
check('their wait is every round so far', cand[0].wait === 2);
check('whoever sat out the last round comes next',
  cand.slice(1, 3).map(c => c.id).sort().join() === ['p2', 'p3'].sort().join());
check('players who just played rank last', cand[cand.length - 1].wait === 0);
check('ties on wait break on fewest games, then name', (() => {
  const a = cand.find(c => c.id === 'p2'), b = cand.find(c => c.id === 'p3');
  return a.wait === b.wait && a.games === b.games && cand.indexOf(a) < cand.indexOf(b); // Cara before Dan
})());
check('everyone playing tonight is a candidate', cand.length === 7);

const goneNight = Object.assign({}, night, { wentHome: ['p6', 'p2'] });
const cand2 = candidatesWith(goneNight, 2);
check('a gone-home player is not a candidate at all', !cand2.some(c => c.id === 'p6' || c.id === 'p2'));
check('the rest still rank by wait', cand2[0].id === 'p3' && cand2.length === 5);
check('round 0 has no waits to compare, so it is stable and deterministic', (() => {
  const c0 = candidatesWith(night, 0);
  return c0.every(c => c.wait === 0 && c.games === 0) && c0[0].name === 'Alice';
})());

// ── autoFillRound: reads the screen, saves, reports ──────────────────
const afSrc = extractFn('autoFillRound', html) || '';
check('it reads the UNSAVED picks off the editor, not the last save',
  afSrc.includes("document.getElementById(`rl_${i}_c${c}_${role}`)") && afSrc.includes("r.courts[c] = { team1:"));
check('a collapsed/unrendered court falls back to stored state', afSrc.includes("if (!el('t1p1')) return;"));
check('a full round is refused rather than rearranged',
  afSrc.includes('Matchmaking.emptySlotsOf(r, known).length') && afSrc.includes('Every slot in this round is filled'));
check('it fills through the pure helper', afSrc.includes('Matchmaking.fillRound(r, ranked.map(x => x.id)'));
check('candidates come from the wait ranking', afSrc.includes('autoFillCandidates(i)'));
check('a refused write is checked before state is updated (apiPost resolves on 4xx)',
  /saved\.error \|\| saved\.ok === false[\s\S]{0,140}state\.rounds = rounds;/.test(afSrc));
check('a 401 bounces out', afSrc.includes('if (saved === null) return;'));
check('the toast names who went in and how long they waited',
  afSrc.includes('Longest waits in:') && afSrc.includes('waitOf[s.id]'));
check('a short fill warns instead of claiming success', afSrc.includes("res.short ? 'warn' : undefined"));
check('the viewer is refreshed too', afSrc.includes('renderViewer();'));
check('every round gets its own button', html.includes('onclick="autoFillRound(${i})"'));
check('the button explains that placed players stay put',
  /Auto-fill only the empty|Fill only the empty slots in this round/.test(html));
check('it sits beside Save Round', html.includes('class="rl-actions"') && html.includes('.rl-actions{'));

// ── a manually added round is genuinely empty ────────────────────────
const addSrc = extractFn('addEmptyRound', html) || '';
check('a hand-added round starts with four blank seats per court',
  addSrc.includes("{ team1: ['', ''], team2: ['', ''] }"));
check('it no longer seeds the first 4N ids on file', !addSrc.includes('pids[c * 4]'));
check('it still opens the new round for editing', addSrc.includes('expandedRound = rounds.length - 1'));

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
console.log(fail ? '\nRESULT: FAIL\n' : '\nRESULT: PASS — per-round auto-fill, empty manual rounds, draggable slots.\n');
process.exit(fail ? 1 : 0);
