#!/usr/bin/env node
/*
 * test-arena-data.js — behavioural guard for the 3D arena's live-data layer.
 *
 * The 3D arena (public/3d/arena-webgl.html) used to render a hardcoded sample
 * roster. It now renders the REAL court state pulled from /api/state. The pure,
 * non-DOM mapping from server state → the arena's MATCHES model lives in three
 * top-level helpers inside arena-webgl.html:
 *
 *   resolvePlayer(state, id)
 *     -> { id, name, photo } | null   (mirrors index.html's playerById: prefer
 *        roster name/photo, fall back to the players entry)
 *
 *   getArenaCourtRounds(state)
 *     -> per-court round index array (state.courtRounds when present & long
 *        enough, else numCourts copies of currentRound)
 *
 *   buildMatchesFromState(state)
 *     -> [{ court, round, roundLabel, t1:[names], t2:[names], photos1, photos2 }]
 *        one entry per court that HAS a match in its current round; courts with
 *        no court slot are omitted. Names are resolved; unknown ids dropped.
 *
 * Pattern matches the other pure-helper guards: extract each function's source
 * from the HTML by brace-matching, eval the trio together, assert behaviour.
 * Exit 0 = green, exit 1 = red.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(path.resolve(__dirname, '..'), 'public', '3d', 'arena-webgl.html');
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

// buildMatchesFromState depends on the other two — eval all three in one scope.
function loadHelpers() {
  const names = ['resolvePlayer', 'getArenaCourtRounds', 'buildMatchesFromState'];
  const sources = names.map(n => {
    const s = extractFn(n, html);
    if (!s) throw new Error(`MISSING helper in arena-webgl.html: ${n}`);
    return s;
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${sources.join('\n')}; return { resolvePlayer, getArenaCourtRounds, buildMatchesFromState };`)();
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

let H;
try {
  H = loadHelpers();
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}

// fixtures ----------------------------------------------------------------
// Mirrors the live shape: roster holds id→name/photo, rounds reference ids,
// per-court round indices via courtRounds.
const state = {
  numCourts: 2,
  currentRound: 0,
  courtRounds: [0, 1],
  roster: [
    { id: 'p0', name: 'Thomas', photo: 'PHOTO0' },
    { id: 'p1', name: 'Desmond', photo: null },
    { id: 'p2', name: 'Celine', photo: null },
    { id: 'p3', name: 'Sharmin', photo: null },
    { id: 'p4', name: 'Terence', photo: null },
    { id: 'p5', name: 'Alex', photo: null },
    { id: 'p6', name: 'Kokyan', photo: null },
    { id: 'p7', name: 'Yit Fung', photo: null },
  ],
  players: [],
  rounds: [
    { label: 'Round 1', courts: [
      { team1: ['p0', 'p1'], team2: ['p2', 'p3'] },
      { team1: ['p4', 'p5'], team2: ['p6', 'p7'] },
    ] },
    { label: 'Round 2', courts: [
      { team1: ['p1', 'p2'], team2: ['p3', 'p4'] },
      { team1: ['p5', 'p6'], team2: ['p7', 'p0'] },
    ] },
  ],
};

// ── resolvePlayer ────────────────────────────────────────────────────────
check('resolvePlayer maps id → name', H.resolvePlayer(state, 'p0').name === 'Thomas');
check('resolvePlayer carries photo', H.resolvePlayer(state, 'p0').photo === 'PHOTO0');
check('resolvePlayer unknown → null', H.resolvePlayer(state, 'zzz') === null);
// roster name/photo preferred over a stale players entry (index.html parity)
const stateOverride = {
  roster: [{ id: 'p0', name: 'Thomas Wong', photo: 'ROSTER' }],
  players: [{ id: 'p0', name: 'OldName', photo: 'OLD' }],
};
check('resolvePlayer prefers roster name', H.resolvePlayer(stateOverride, 'p0').name === 'Thomas Wong');
check('resolvePlayer prefers roster photo', H.resolvePlayer(stateOverride, 'p0').photo === 'ROSTER');

// ── getArenaCourtRounds ──────────────────────────────────────────────────
const cr = H.getArenaCourtRounds(state);
check('getArenaCourtRounds honours courtRounds', Array.isArray(cr) && cr[0] === 0 && cr[1] === 1);
const crFallback = H.getArenaCourtRounds({ numCourts: 3, currentRound: 2 });
check('getArenaCourtRounds falls back to currentRound', crFallback.length === 3 && crFallback.every(r => r === 2));

// ── buildMatchesFromState ────────────────────────────────────────────────
const m = H.buildMatchesFromState(state);
check('buildMatches → one entry per court', m.length === 2);
check('buildMatches court 1 number', m[0].court === 1);
// court 0 is on round index 0; court 1 is on round index 1 (per courtRounds)
check('buildMatches court 1 uses its round index', m[0].round === 1 && m[0].roundLabel === 'Round 1');
check('buildMatches court 2 uses its round index', m[1].round === 2 && m[1].roundLabel === 'Round 2');
check('buildMatches resolves team1 names', m[0].t1.join(',') === 'Thomas,Desmond');
check('buildMatches resolves team2 names', m[0].t2.join(',') === 'Celine,Sharmin');
check('buildMatches court 2 team1 from round 2', m[1].t1.join(',') === 'Alex,Kokyan');

// missing court slot is omitted, not crashed
const sparse = {
  numCourts: 2, currentRound: 0, courtRounds: [0, 0],
  roster: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ben' }],
  rounds: [{ label: 'Round 1', courts: [{ team1: ['a'], team2: ['b'] }] }], // only 1 court slot
};
const ms = H.buildMatchesFromState(sparse);
check('buildMatches omits courts with no slot', ms.length === 1 && ms[0].court === 1);
check('buildMatches singles team has one name', ms[0].t1.join(',') === 'Ann' && ms[0].t2.join(',') === 'Ben');

// unknown ids are dropped from a team rather than rendered as blanks
const withUnknown = {
  numCourts: 1, currentRound: 0, courtRounds: [0],
  roster: [{ id: 'a', name: 'Ann' }],
  rounds: [{ label: 'Round 1', courts: [{ team1: ['a', 'ghost'], team2: ['', 'a'] }] }],
};
const mu = H.buildMatchesFromState(withUnknown);
check('buildMatches drops unknown ids', mu[0].t1.join(',') === 'Ann');
check('buildMatches drops empty ids', mu[0].t2.join(',') === 'Ann');

// empty / malformed state never throws
check('buildMatches handles null state', Array.isArray(H.buildMatchesFromState(null)) && H.buildMatchesFromState(null).length === 0);
check('buildMatches handles empty rounds', H.buildMatchesFromState({ numCourts: 2, rounds: [] }).length === 0);

// ── report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error('✗ test-arena-data: ' + failures.length + ' failure(s):');
  failures.forEach(f => console.error('   - ' + f));
  process.exit(1);
}
console.log('✓ test-arena-data: all arena live-data helpers pass');
process.exit(0);
