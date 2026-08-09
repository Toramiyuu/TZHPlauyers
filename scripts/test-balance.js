#!/usr/bin/env node
/* Tests for the level-balanced schedule generator (public/matchmaking.js).
 *
 * Contract:
 *  - smartSchedule(players, numCourts, numRounds, metaById) keeps the old
 *    selection (rest rotation + play-count fairness) and partner-variety
 *    behaviour, but now forms pairs toward a common team-sum target and matches
 *    pairs (mixed-vs-mixed first, then closest sums). Output shape unchanged.
 *  - Unrated players / guests (no meta entry, blank/NaN level) count as 4.0.
 *  - courtBalanceInfo(court, metaById) is pure and never throws on ''/unknown ids.
 *  - roundLevel(v) rounds to the nearest 0.5, clamped 1–7; blank/NaN -> null.
 */
'use strict';
const { smartSchedule, courtBalanceInfo, levelOf, roundLevel, UNRATED, TOL } =
  require('../public/matchmaking.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));
const idsInRound = (rd) => rd.courts.reduce((a, c) => a.concat(c.team1, c.team2), []);
const teammateOf = (id, rd) => {
  for (const c of rd.courts) {
    for (const team of [c.team1, c.team2]) {
      if (team.includes(id)) return team[0] === id ? team[1] : team[0];
    }
  }
  return null;
};

// ── roundLevel — nearest 0.5, clamp 1–7, blank/NaN -> null ──
check('roundLevel "3.7" -> 3.5', roundLevel('3.7') === 3.5);
check('roundLevel "6.74" -> 6.5', roundLevel('6.74') === 6.5);
check('roundLevel "9" -> 7 (clamp high)', roundLevel('9') === 7);
check('roundLevel "0" -> 1 (clamp low)', roundLevel('0') === 1);
check('roundLevel "" -> null', roundLevel('') === null);
check('roundLevel null -> null', roundLevel(null) === null);
check('roundLevel "abc" -> null', roundLevel('abc') === null);
check('roundLevel "4.25" -> 4.5 (half rounds up)', roundLevel('4.25') === 4.5);
check('roundLevel "4.2" -> 4.0', roundLevel('4.2') === 4);
check('roundLevel 5 (number) -> 5', roundLevel(5) === 5);

// ── levelOf — missing/NaN -> 4.0 ──
check('levelOf unknown id -> 4.0', levelOf('nope', {}) === UNRATED);
check('levelOf undefined meta -> 4.0', levelOf('x', undefined) === UNRATED);
check('levelOf blank level -> 4.0', levelOf('a', { a: { level: NaN } }) === UNRATED);
check('levelOf real level', levelOf('a', { a: { level: 6.5 } }) === 6.5);
check('levelOf string level', levelOf('a', { a: { level: '3.5' } }) === 3.5);
check('UNRATED is 4.0', UNRATED === 4.0);

// ── courtBalanceInfo — tolerant of ''/unknown/missing ids ──
{
  const meta = { p0: { level: 6.5 }, p1: { level: 1.5 } };
  const b = courtBalanceInfo({ team1: ['p0', 'p1'], team2: ['', 'x'] }, meta);
  check('balance: sum1 = 6.5+1.5 = 8', b.sum1 === 8);
  check('balance: sum2 = 4+4 = 8 (empty+unknown)', b.sum2 === 8);
  check('balance: gap 0', b.gap === 0);
  check('balance: not bothMixed', b.bothMixed === false);

  check('balance: empty court no throw', courtBalanceInfo({ team1: ['', ''], team2: ['', ''] }, meta).sum1 === 8);
  check('balance: undefined court no throw', courtBalanceInfo(undefined, meta).sum1 === 8);
  check('balance: short team no throw', courtBalanceInfo({ team1: ['p0'], team2: ['p1'] }, meta).sum1 === 10.5);
}

// ── bothMixed detection (girl+guy vs girl+guy) ──
{
  const meta = {
    g1: { level: 4, girl: true }, m1: { level: 4 },
    g2: { level: 4, girl: true }, m2: { level: 4 },
  };
  check('bothMixed true when each team is girl+guy',
    courtBalanceInfo({ team1: ['g1', 'm1'], team2: ['g2', 'm2'] }, meta).bothMixed === true);
  check('bothMixed false when a team is two girls',
    courtBalanceInfo({ team1: ['g1', 'g2'], team2: ['m1', 'm2'] }, meta).bothMixed === false);
}

// ── Integrity: no dup in a round, everyone selected once, court count right ──
{
  const players = mkPlayers(10);
  const rounds = smartSchedule(players, 2, 12, {}); // perRound=8, activeCourts=2
  let ok = true, courtsOk = true;
  const valid = new Set(players.map(p => p.id));
  rounds.forEach(rd => {
    if (rd.courts.length !== 2) courtsOk = false;
    const ids = idsInRound(rd);
    if (ids.length !== 8) ok = false;
    if (new Set(ids).size !== 8) ok = false;            // no duplicate player
    if (!ids.every(id => valid.has(id))) ok = false;    // only real players
  });
  check('integrity: 2 courts every round', courtsOk);
  check('integrity: 8 distinct valid players per round', ok);
}

// ── Rest fairness preserved: max(play) - min(play) <= 1 when n % 4 != 0 ──
function playSpread(n, courts, r) {
  const players = mkPlayers(n);
  const rounds = smartSchedule(players, courts, r, {});
  const count = Object.fromEntries(players.map(p => [p.id, 0]));
  rounds.forEach(rd => idsInRound(rd).forEach(id => { count[id]++; }));
  const vals = Object.values(count);
  return Math.max(...vals) - Math.min(...vals);
}
check('rest fairness: 10 players / 2 courts / 7 rounds, spread <= 1', playSpread(10, 2, 7) <= 1);
check('rest fairness: 5 players / 1 court / 9 rounds, spread <= 1', playSpread(5, 1, 9) <= 1);
check('rest fairness: 6 players / 1 court / 11 rounds, spread <= 1', playSpread(6, 1, 11) <= 1);

// ── Feasible roster: all-equal levels -> every court within ±0.5 (all rounds) ──
{
  const players = mkPlayers(8);
  const meta = {}; players.forEach(p => { meta[p.id] = { level: 4 }; });
  const rounds = smartSchedule(players, 2, 10, meta);
  let allBalanced = true;
  rounds.forEach(rd => rd.courts.forEach(c => {
    if (courtBalanceInfo(c, meta).gap > TOL + 1e-9) allBalanced = false;
  }));
  check('feasible (equal levels): every court within ±0.5', allBalanced);
}

// ── Feasible spread, round 1 (variety=0): closest pairing balances all courts ──
{
  const players = mkPlayers(8);
  const lv = [3, 3, 4, 4, 4, 4, 5, 5];
  const meta = {}; players.forEach((p, i) => { meta[p.id] = { level: lv[i] }; });
  const rounds = smartSchedule(players, 2, 1, meta);
  const gaps = rounds[0].courts.map(c => courtBalanceInfo(c, meta).gap);
  check('feasible (spread, round 1): all courts within ±0.5', gaps.every(g => g <= TOL + 1e-9));
}

// ── Mixed-OFF girls: never paired with a guy when a girl partner existed ──
{
  const players = mkPlayers(8);
  const meta = {};
  players.forEach(p => { meta[p.id] = { level: 4 }; });
  meta.p0 = { level: 4, girl: true, mixed: false }; // two mixed-off girls (even)
  meta.p1 = { level: 4, girl: true, mixed: false };
  const isGirl = id => !!(meta[id] && meta[id].girl);
  const rounds = smartSchedule(players, 2, 8, meta);
  let ok = true;
  rounds.forEach(rd => {
    // both girls always selected (perRound = 8 = all players)
    ['p0', 'p1'].forEach(g => {
      const mate = teammateOf(g, rd);
      if (mate && !isGirl(mate)) ok = false; // paired with a guy despite a free girl partner
    });
  });
  check('mixed-off girls partnered with a girl (girl partner available)', ok);
}

// ── Mixed-ON girls: get guy partners; mixed pairs face mixed pairs (>=2) ──
{
  const players = mkPlayers(8);
  const meta = {};
  players.forEach(p => { meta[p.id] = { level: 4 }; });
  meta.p0 = { level: 4, girl: true, mixed: true };
  meta.p1 = { level: 4, girl: true, mixed: true };
  const isGirl = id => !!(meta[id] && meta[id].girl);
  const rounds = smartSchedule(players, 2, 6, meta);
  let guyPartners = true, sawBothMixedCourt = true;
  rounds.forEach(rd => {
    ['p0', 'p1'].forEach(g => {
      const mate = teammateOf(g, rd);
      if (mate && isGirl(mate)) guyPartners = false; // 6 guys available -> should be a guy
    });
    // the two mixed pairs should be matched against each other on one court
    if (!rd.courts.some(c => courtBalanceInfo(c, meta).bothMixed)) sawBothMixedCourt = false;
  });
  check('mixed-on girls get guy partners (guys available)', guyPartners);
  check('two mixed pairs meet on a mixed court every round', sawBothMixedCourt);
}

// ── Mixed-OFF girl relaxes to a guy only when no girl partner is free ──
{
  const players = mkPlayers(8);
  const meta = {};
  players.forEach(p => { meta[p.id] = { level: 4 }; });
  meta.p0 = { level: 4, girl: true, mixed: false }; // odd count -> one must relax
  meta.p1 = { level: 4, girl: true, mixed: false };
  meta.p2 = { level: 4, girl: true, mixed: false };
  // Should not throw, still fills 2 courts with all 8 players.
  let ok = true;
  const rounds = smartSchedule(players, 2, 4, meta);
  rounds.forEach(rd => { if (new Set(idsInRound(rd)).size !== 8) ok = false; });
  check('odd mixed-off girls: round still full (relaxation allowed)', ok);
}

// ── Guests (in players, not in metaById) read as 4.0; generation never blocks ──
{
  const players = mkPlayers(7).concat([{ id: 'guest1' }]); // 8 players, one guest
  const meta = {}; players.slice(0, 7).forEach(p => { meta[p.id] = { level: 5 }; });
  let ok = true, guestPlays = false;
  const rounds = smartSchedule(players, 2, 5, meta);
  rounds.forEach(rd => {
    if (new Set(idsInRound(rd)).size !== 8) ok = false;
    if (idsInRound(rd).includes('guest1')) guestPlays = true;
  });
  check('guest: generation fills every court', ok);
  check('guest: guest is scheduled', guestPlays);
  check('guest: guest reads as level 4.0', levelOf('guest1', meta) === 4);
}

// ── All-guys night (zero girls): passes fall through cleanly ──
{
  const players = mkPlayers(8);
  const meta = {}; players.forEach((p, i) => { meta[p.id] = { level: 3 + (i % 3) }; });
  let ok = true;
  const rounds = smartSchedule(players, 2, 6, meta);
  rounds.forEach(rd => { if (new Set(idsInRound(rd)).size !== 8) ok = false; });
  check('all-guys night: rounds valid', ok);
}

// ── Report ──
console.log('');
if (fail) {
  console.log(`test-balance: FAIL — ${fail} failed, ${pass} passed`);
  process.exit(1);
} else {
  console.log(`test-balance: PASS — ${pass} checks`);
  process.exit(0);
}
