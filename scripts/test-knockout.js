#!/usr/bin/env node
/* Tests for the open-competition pure logic (public/knockout.js).
 *
 * Covers the four things that would quietly ruin a real tournament night:
 *   1. bracket maths — a 20-entrant field must become a 32 draw with 12 byes,
 *      and seed 1 must not be able to meet seed 2 before the final;
 *   2. derived resolution — correcting a mis-typed result must invalidate
 *      everything downstream of it instead of leaving a ghost in a later round;
 *   3. the small-field switch — 5 confirmed entrants runs a round robin, 6 runs
 *      a knockout;
 *   4. privacy — the public projection must never carry a phone number, an IC
 *      (encrypted or last-four), a category code or an unconfirmed entrant.
 */
'use strict';
const K = require('../public/knockout.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };
const ids = (n, p) => Array.from({ length: n }, (_, i) => (p || 'e') + (i + 1));

// ── bracket size ─────────────────────────────────────────────────────
check('bracketSize(2) = 2', K.bracketSize(2) === 2);
check('bracketSize(3) = 4', K.bracketSize(3) === 4);
check('bracketSize(5) = 8', K.bracketSize(5) === 8);
check('bracketSize(20) = 32', K.bracketSize(20) === 32);
check('bracketSize(32) = 32', K.bracketSize(32) === 32);
check('bracketSize(33) = 64', K.bracketSize(33) === 64);
check('bracketSize(0) clamps to 2', K.bracketSize(0) === 2);
check('byeCount(20) = 12', K.byeCount(20) === 12);
check('byeCount(16) = 0', K.byeCount(16) === 0);
check('byeCount(5) = 3', K.byeCount(5) === 3);

// ── seeding ──────────────────────────────────────────────────────────
{
  const o4 = K.seedOrder(4), o8 = K.seedOrder(8), o32 = K.seedOrder(32);
  check('seedOrder(4) has 4 slots', o4.length === 4);
  check('seedOrder(8) has 8 slots', o8.length === 8);
  check('seedOrder(4) is a permutation of 1..4', [...o4].sort((a, b) => a - b).join() === '1,2,3,4');
  check('seedOrder(32) is a permutation of 1..32', [...o32].sort((a, b) => a - b).join() === ids(32).map((_, i) => i + 1).join());
  // The defining property: every first-round pair of seeds sums to size + 1.
  const pairsSum = (o, size) => { for (let i = 0; i < o.length; i += 2) if (o[i] + o[i + 1] !== size + 1) return false; return true; };
  check('seedOrder(8) pairs sum to 9', pairsSum(o8, 8));
  check('seedOrder(32) pairs sum to 33', pairsSum(o32, 32));
  // Seed 1 and seed 2 must sit in opposite halves, or they could meet early.
  const half = (o, s) => (o.indexOf(s) < o.length / 2 ? 'top' : 'bottom');
  check('seed 1 and 2 in opposite halves (8)', half(o8, 1) !== half(o8, 2));
  check('seed 1 and 2 in opposite halves (32)', half(o32, 1) !== half(o32, 2));
  check('seed 1 and 3 in opposite halves (32)', half(o32, 1) !== half(o32, 3));
}
{
  // 20 entrants in a 32 draw: the top 12 seeds get the byes.
  const slots = K.seedSlots(ids(20), 32);
  check('seedSlots(20) fills 32 slots', slots.length === 32);
  check('seedSlots(20) leaves 12 empty', slots.filter((x) => x === null).length === 12);
  check('seedSlots puts seed 1 in slot 0', slots[0] === 'e1');
  check('seed 1 faces a bye', slots[1] === null);
  const withBye = new Set();
  for (let i = 0; i < 32; i += 2) {
    if (slots[i] && !slots[i + 1]) withBye.add(slots[i]);
    if (slots[i + 1] && !slots[i]) withBye.add(slots[i + 1]);
  }
  check('exactly the top 12 seeds get byes', withBye.size === 12 && ids(12).every((id) => withBye.has(id)));
  check('seed 13 does NOT get a bye', !withBye.has('e13'));
}

// ── round names ──────────────────────────────────────────────────────
check('roundName(32,1) = Round of 32', K.roundName(32, 1) === 'Round of 32');
check('roundName(32,2) = Round of 16', K.roundName(32, 2) === 'Round of 16');
check('roundName(32,3) = Quarter-finals', K.roundName(32, 3) === 'Quarter-finals');
check('roundName(32,4) = Semi-finals', K.roundName(32, 4) === 'Semi-finals');
check('roundName(32,5) = Final', K.roundName(32, 5) === 'Final');
check('roundName(2,1) = Final', K.roundName(2, 1) === 'Final');
check('roundCount(32) = 5', K.roundCount(32) === 5);

// ── knockout skeleton ────────────────────────────────────────────────
{
  const d = K.buildKnockoutDraw(ids(20), { nowMs: 1000, thirdPlace: true });
  check('20 entrants -> size 32', d.size === 32);
  check('31 bracket matches + 1 third place', d.matches.length === 32);
  check('third place flagged', d.thirdPlace === true);
  check('final is the last bracket match', d.matches.filter((m) => m.label === 'Final').length === 1);
  const r = K.resolveDraw(d);
  check('12 first-round byes resolve automatically', r.matches.filter((m) => m.bye).length === 12);
  check('byes already have a winner', r.matches.filter((m) => m.bye).every((m) => !!m.winner));
  check('4 real first-round matches', r.matches.filter((m) => m.round === 1 && !m.bye).length === 4);
  check('real first-round matches are ready to play', r.matches.filter((m) => m.round === 1 && !m.bye).every((m) => m.state === 'ready'));
  check('the final is still waiting', r.byId['r5m1'].state === 'waiting');
  check('nobody has won yet', r.champion === null && r.complete === false);
  check('readyMatches only returns playable ones', K.readyMatches(d).every((m) => m.a && m.b && !m.winner));
}
{
  // No third-place playoff when it is switched off.
  const d = K.buildKnockoutDraw(ids(8), { nowMs: 1, thirdPlace: false });
  check('8 entrants, no bronze -> 7 matches', d.matches.length === 7);
  check('8 entrants -> no byes', K.resolveDraw(d).matches.filter((m) => m.bye).length === 0);
}

// ── playing a bracket out ────────────────────────────────────────────
{
  let d = K.buildKnockoutDraw(ids(20), { nowMs: 1, thirdPlace: true });
  let guard = 0;
  while (guard++ < 200) {
    const ready = K.readyMatches(d);
    if (!ready.length) break;
    for (const m of ready) d.results[m.id] = { winner: m.a, score: '21-15, 21-12', at: 100 };
  }
  const r = K.resolveDraw(d);
  check('bracket plays out to a champion', r.complete === true && r.champion === 'e1');
  check('runner-up recorded', !!r.runnerUp && r.runnerUp !== r.champion);
  check('third place decided', !!r.third);
  check('every match resolved', r.matches.every((m) => !!m.winner));
}
{
  // Correcting a result must wipe what followed from it, not leave a ghost.
  let d = K.buildKnockoutDraw(ids(4), { nowMs: 1, thirdPlace: false });
  const first = K.resolveDraw(d).matches.filter((m) => m.round === 1);
  d.results[first[0].id] = { winner: first[0].a, score: '21-10', at: 1 };
  d.results[first[1].id] = { winner: first[1].a, score: '21-11', at: 2 };
  const finalId = K.resolveDraw(d).matches.find((m) => m.label === 'Final').id;
  d.results[finalId] = { winner: first[0].a, score: '21-19', at: 3 };
  check('champion set before the correction', K.resolveDraw(d).champion === first[0].a);
  const lost = K.downstreamResults(d, first[0].id, first[0].b);
  check('downstreamResults flags the final', lost.includes(finalId));
  // Admin corrects the first semi: the other side actually won.
  d.results[first[0].id] = { winner: first[0].b, score: '19-21, 15-21', at: 4 };
  const after = K.resolveDraw(d);
  check('stale final result is ignored, not shown', after.champion === null);
  check('final now waits on the corrected side', after.byId[finalId].a === first[0].b);
  check('the untouched semi keeps its result', after.byId[first[1].id].winner === first[1].a);
}

// ── round robin ──────────────────────────────────────────────────────
{
  const d = K.buildRoundRobinDraw(ids(5), { nowMs: 1, finalAfterRR: true });
  const group = d.matches.filter((m) => m.id !== 'rrfinal');
  check('5 entrants -> 10 group matches', group.length === 10);
  check('plus a final', d.matches.length === 11 && d.finalAfterRR === true);
  const seen = new Set(group.map((m) => [m.aId, m.bId].sort().join('|')));
  check('every pair meets exactly once', seen.size === 10);
  check('nobody is drawn against themselves', group.every((m) => m.aId !== m.bId));
  const counts = {};
  for (const m of group) { counts[m.aId] = (counts[m.aId] || 0) + 1; counts[m.bId] = (counts[m.bId] || 0) + 1; }
  check('everyone plays 4 group matches', ids(5).every((id) => counts[id] === 4));
  check('even field also works (4 -> 6 matches)', K.buildRoundRobinDraw(ids(4), { finalAfterRR: false }).matches.length === 6);
}
{
  // Standings order by wins, then game difference.
  let d = K.buildRoundRobinDraw(ids(4), { nowMs: 1, finalAfterRR: false });
  const ent = ids(4).map((id) => ({ id, players: [{ name: 'P' + id }] }));
  for (const m of d.matches) {
    // e1 beats everyone, e2 beats e3 and e4, e3 beats e4.
    const rank = { e1: 1, e2: 2, e3: 3, e4: 4 };
    const w = rank[m.aId] < rank[m.bId] ? m.aId : m.bId;
    d.results[m.id] = { winner: w, score: '21-10, 21-10', at: 1 };
  }
  const t = K.standings(d, ent);
  check('standings sorted by wins', t.map((r) => r.id).join() === 'e1,e2,e3,e4');
  check('standings carry position', t[0].pos === 1 && t[3].pos === 4);
  check('top seed won 3', t[0].won === 3 && t[0].lost === 0);
  check('bottom seed won 0', t[3].won === 0 && t[3].lost === 3);
  check('labels come from the entrants', t[0].label === 'Pe1');
  check('a decided table flags no false ties', t.every((r) => !r.tied));
}
{
  // An untouched table is level on nothing, which is not a tie worth flagging.
  const d = K.buildRoundRobinDraw(ids(4), { nowMs: 1, finalAfterRR: false });
  const ent = ids(4).map((id) => ({ id, players: [{ name: id }] }));
  const t = K.standings(d, ent);
  check('an unplayed table flags nobody as tied', t.every((r) => !r.tied && r.played === 0));
  // Two entrants who have each won one, with identical margins, genuinely are.
  const d2 = K.buildRoundRobinDraw(ids(4), { nowMs: 1, finalAfterRR: false });
  for (const m of d2.matches) {
    const rank = { e1: 1, e2: 2, e3: 3, e4: 4 };
    d2.results[m.id] = { winner: rank[m.aId] < rank[m.bId] ? m.aId : m.bId, score: '21-10, 21-10', at: 1 };
  }
  check('a real table still sorts correctly', K.standings(d2, ent).map((r) => r.id).join() === 'e1,e2,e3,e4');
}
{
  // The round-robin final only appears once every group match is in.
  let d = K.buildRoundRobinDraw(ids(3), { nowMs: 1, finalAfterRR: true });
  const ent = ids(3).map((id) => ({ id, players: [{ name: id }] }));
  check('finalists unknown while matches remain', K.rrFinalists(d, ent) === null);
  for (const m of d.matches.filter((x) => x.id !== 'rrfinal')) d.results[m.id] = { winner: m.aId, score: '21-10', at: 1 };
  const f = K.rrFinalists(d, ent);
  check('finalists resolve once the group is done', !!f && !!f.a && !!f.b && f.a !== f.b);
  const filled = K.withRRFinalists(d, ent);
  check('final becomes playable', K.resolveDraw(filled).byId.rrfinal.state === 'ready');
}

// ── the small-field switch ───────────────────────────────────────────
{
  const cat = (n, fmt) => ({ id: 'c1', name: 'X', type: 'doubles', format: fmt || 'auto', entrants: ids(n).map((id) => ({ id, status: 'confirmed', players: [{ name: id }, { name: id + 'b' }] })) });
  check('auto: 5 confirmed -> round robin', K.effectiveFormat(cat(5)) === 'roundrobin');
  check('auto: 6 confirmed -> knockout', K.effectiveFormat(cat(6)) === 'knockout');
  check('auto: 2 confirmed -> round robin', K.effectiveFormat(cat(2)) === 'roundrobin');
  check('auto: 20 confirmed -> knockout', K.effectiveFormat(cat(20)) === 'knockout');
  check('explicit knockout overrides the switch', K.effectiveFormat(cat(3, 'knockout')) === 'knockout');
  check('explicit round robin overrides the switch', K.effectiveFormat(cat(20, 'roundrobin')) === 'roundrobin');
  check('buildDraw picks round robin for 5', K.buildDraw(cat(5), { nowMs: 1 }).draw.format === 'roundrobin');
  check('buildDraw picks knockout for 6', K.buildDraw(cat(6), { nowMs: 1 }).draw.format === 'knockout');
  const one = K.buildDraw(cat(1), { nowMs: 1 });
  check('buildDraw refuses a field of 1', one.ok === false && typeof one.error === 'string' && one.error.length > 0);
  // Pending entries must not end up in the draw.
  const mixed = { id: 'c2', name: 'Y', type: 'singles', format: 'knockout', entrants: [
    { id: 'a', status: 'confirmed', players: [{ name: 'A' }] },
    { id: 'b', status: 'pending', players: [{ name: 'B' }] },
    { id: 'c', status: 'withdrawn', players: [{ name: 'C' }] },
    { id: 'd', status: 'confirmed', players: [{ name: 'D' }] },
  ] };
  const md = K.buildDraw(mixed, { nowMs: 1 });
  check('only confirmed entrants are drawn', md.ok === true && md.draw.slots.filter(Boolean).sort().join() === 'a,d');
}
{
  // Admin seeding order (drag to reorder) decides who is seed 1.
  const cat = { id: 'c', name: 'X', type: 'singles', format: 'knockout', entrants: [
    { id: 'x', status: 'confirmed', seed: 3, at: 1, players: [{ name: 'X' }] },
    { id: 'y', status: 'confirmed', seed: 1, at: 2, players: [{ name: 'Y' }] },
    { id: 'z', status: 'confirmed', seed: 2, at: 3, players: [{ name: 'Z' }] },
    { id: 'w', status: 'confirmed', seed: null, at: 4, players: [{ name: 'W' }] },
  ] };
  const d = K.buildDraw(cat, { nowMs: 1 }).draw;
  check('lowest seed number takes slot 0', d.slots[0] === 'y');
  check('unseeded entrant sorts last', d.slots[K.seedOrder(4).indexOf(4)] === 'w');
}

// ── labels ───────────────────────────────────────────────────────────
check('doubles label joins with &', K.entrantLabel({ players: [{ name: 'Alex Tan' }, { name: 'Wei Ming' }] }) === 'Alex Tan & Wei Ming');
check('singles label is just the name', K.entrantLabel({ players: [{ name: 'Alex Tan' }] }) === 'Alex Tan');
check('empty entrant labels as TBC', K.entrantLabel({ players: [] }) === 'TBC');
check('club skips free agents', K.entrantClub({ players: [{ name: 'A', club: 'Free Agent' }, { name: 'B', club: 'TZH' }] }) === 'TZH');
check('two free agents -> no club shown', K.entrantClub({ players: [{ name: 'A', club: 'Free Agent' }, { name: 'B', club: 'Free Agent' }] }) === '');

// ── registration validation ──────────────────────────────────────────
{
  const doubles = { id: 'c1', type: 'doubles', status: 'open', entrants: [] };
  const singles = { id: 'c2', type: 'singles', status: 'open', entrants: [] };
  const P = (o) => Object.assign({ name: 'Alex Tan', phone: '0123456789', ic: '900101075511', club: '' }, o);

  check('doubles needs two players', K.validateEntry({ players: [P()] }, { category: doubles }).ok === false);
  check('singles rejects two players', K.validateEntry({ players: [P(), P({ name: 'Wei Ming' })] }, { category: singles }).ok === false);
  const good = K.validateEntry({ players: [P(), P({ name: 'Wei Ming', ic: '910202085522' })] }, { category: doubles });
  check('a complete doubles pair validates', good.ok === true && good.clean.players.length === 2);
  check('club defaults to Free Agent', good.clean.players[0].club === K.FREE_AGENT);
  check('phone is stored as digits only', K.validateEntry({ players: [P({ phone: '012-345 6789' })] }, { category: singles }).clean.players[0].phone === '0123456789');
  check('short name rejected', K.validateEntry({ players: [P({ name: 'A' })] }, { category: singles }).ok === false);
  check('short phone rejected', K.validateEntry({ players: [P({ phone: '123' })] }, { category: singles }).ok === false);
  check('letters-only phone rejected', K.validateEntry({ players: [P({ phone: 'call me' })] }, { category: singles }).ok === false);
  check('missing IC rejected when required', K.validateEntry({ players: [P({ ic: '' })] }, { category: singles }).ok === false);
  check('missing IC accepted when not required', K.validateEntry({ players: [P({ ic: '' })] }, { category: singles, requireIC: false }).ok === true);
  check('same name twice rejected', K.validateEntry({ players: [P(), P({ ic: '910202085522' })] }, { category: doubles }).ok === false);
  check('same IC twice rejected', K.validateEntry({ players: [P(), P({ name: 'Wei Ming' })] }, { category: doubles }).ok === false);
  check('IC is normalised (dashes stripped)', K.normIC('900101-07-5511') === '900101075511');
  check('icLast4 takes the last four', K.icLast4('900101-07-5511') === '5511');
  check('maskIC hides everything but four', K.maskIC('5511') === '••••5511');
  check('every error carries a message', K.validateEntry({ players: [] }, { category: doubles }).error.length > 0);
}
{
  const cat = { id: 'c1', type: 'singles', status: 'open', cap: 0, entrants: [] };
  const entry = { players: [{ name: 'Alex Tan', phone: '0123456789', ic: '900101075511' }] };
  check('a valid submission passes', K.validateSubmission({ entries: [entry] }, { category: cat }).ok === true);
  check('no entries rejected', K.validateSubmission({ entries: [] }, { category: cat }).ok === false);
  check('over the per-submit cap rejected', K.validateSubmission({ entries: Array(K.MAX_PER_SUBMIT + 1).fill(entry) }, { category: cat }).ok === false);
  check('a closed category rejects entries', K.validateSubmission({ entries: [entry] }, { category: Object.assign({}, cat, { status: 'closed' }) }).ok === false);
  check('a drawn category rejects entries', K.validateSubmission({ entries: [entry] }, { category: Object.assign({}, cat, { status: 'drawn' }) }).ok === false);
  check('closed registration rejects entries', K.validateSubmission({ entries: [entry] }, { category: cat, regOpen: false }).ok === false);
  check('unknown category rejected', K.validateSubmission({ entries: [entry] }, { category: {} }).ok === false);
  const full = { id: 'c1', type: 'singles', status: 'open', cap: 2, entrants: [
    { id: 'a', status: 'confirmed', players: [{ name: 'A' }] }, { id: 'b', status: 'pending', players: [{ name: 'B' }] } ] };
  check('a full category rejects entries', K.validateSubmission({ entries: [entry] }, { category: full }).ok === false);
  check('pending entries hold a place', K.isFull(full) === true && K.spacesLeft(full) === 0);
  check('uncapped category reports null spaces', K.spacesLeft(cat) === null);
  const half = Object.assign({}, full, { cap: 3 });
  check('one place left rejects two entries', K.validateSubmission({ entries: [entry, entry] }, { category: half }).ok === false);
  check('one place left accepts one entry', K.validateSubmission({ entries: [entry] }, { category: half }).ok === true);
}
{
  const cat = { id: 'c', type: 'doubles', status: 'open', entrants: [
    { id: 'e1', status: 'confirmed', players: [{ name: 'Alex Tan', icLast4: '5511' }, { name: 'Wei Ming', icLast4: '5522' }] } ] };
  check('same pair again is a duplicate', K.isDuplicateEntry(cat, [{ name: 'Alex Tan', ic: '900101075511' }, { name: 'Wei Ming', ic: '910202085522' }]) === true);
  check('order does not matter', K.isDuplicateEntry(cat, [{ name: 'Wei Ming', ic: '910202085522' }, { name: 'Alex Tan', ic: '900101075511' }]) === true);
  check('a different pair is not a duplicate', K.isDuplicateEntry(cat, [{ name: 'Sam Lee', ic: '920303095533' }, { name: 'Jo Ng', ic: '930404105544' }]) === false);
}

// ── scores ───────────────────────────────────────────────────────────
{
  const p = K.parseScore('21-15, 19-21, 21-17');
  check('three-game score parses', p.ok === true && p.games.length === 3);
  check('games counted', p.setsA === 2 && p.setsB === 1);
  check('points totalled', p.ptsA === 61 && p.ptsB === 53);
  check('en dash accepted', K.parseScore('21–15').ok === true);
  check('free text does not throw', K.parseScore('walkover').ok === false);
  check('empty score is fine', K.parseScore('').ok === false);
}
{
  let d = K.buildKnockoutDraw(ids(4), { nowMs: 1, thirdPlace: false });
  const m = K.readyMatches(d)[0];
  check('winner must be in the match', K.validateResult(d, m.id, { winner: 'nobody' }).ok === false);
  check('a real winner validates', K.validateResult(d, m.id, { winner: m.a, score: '21-10' }).ok === true);
  check('unknown match rejected', K.validateResult(d, 'nope', { winner: m.a }).ok === false);
  const finalId = d.matches[d.matches.length - 1].id;
  check('cannot score a match that has no players yet', K.validateResult(d, finalId, { winner: m.a }).ok === false);
  const bye = K.resolveDraw(K.buildKnockoutDraw(ids(3), { nowMs: 1 })).matches.find((x) => x.bye);
  check('cannot score a bye', K.validateResult(K.buildKnockoutDraw(ids(3), { nowMs: 1 }), bye.id, { winner: bye.winner }).ok === false);
}

// ── privacy: the public projection ───────────────────────────────────
{
  const ko = {
    event: { name: 'TZH Open 2026', date: '2026-11-08', venue: 'TZH Hall', regOpen: true, published: true },
    categories: [{
      id: 'c1', name: "Men's Doubles Open", type: 'doubles', code: 'MDOPEN', cap: 16, fee: 40, status: 'open',
      entrants: [
        { id: 'e1', at: 1, status: 'confirmed', paid: true, seed: 1, players: [
          { name: 'Alex Tan', phone: '0123456789', club: 'TZH', icLast4: '5511', icEnc: { iv: 'x', ct: 'y', tag: 'z', k: 1 } },
          { name: 'Wei Ming', phone: '0129876543', club: 'TZH', icLast4: '5522', icEnc: { iv: 'x', ct: 'y', tag: 'z', k: 1 } } ] },
        { id: 'e2', at: 2, status: 'pending', paid: false, players: [
          { name: 'Secret Person', phone: '0111111111', club: 'Free Agent', icLast4: '9999', icEnc: { iv: 'x', ct: 'y', tag: 'z', k: 1 } } ] },
      ],
      draw: null,
    }],
  };
  const pub = K.publicKnockout(ko);
  const blob = JSON.stringify(pub);
  check('no phone numbers in the public projection', !blob.includes('0123456789') && !blob.includes('0111111111'));
  check('no IC last-four in the public projection', !blob.includes('5511') && !blob.includes('5522'));
  check('no encrypted IC blob in the public projection', !blob.includes('icEnc') && !blob.includes('"ct"'));
  check('no category code in the public projection', !blob.includes('MDOPEN'));
  check('no pending entrant in the public projection', !blob.includes('Secret Person'));
  check('confirmed entrant label IS public (it goes on the bracket)', blob.includes('Alex Tan & Wei Ming'));
  check('public projection keeps the category name', pub.categories[0].name === "Men's Doubles Open");
  check('public projection counts confirmed entries', pub.categories[0].entries === 1);
  check('public projection says a code exists without giving it', pub.categories[0].hasCode === true);
  check('paid flags stay private', !blob.includes('paid'));

  const hidden = K.publicKnockout(Object.assign({}, ko, { event: Object.assign({}, ko.event, { published: false }) }));
  check('an unpublished event leaks nothing at all', hidden.categories.length === 0 && !JSON.stringify(hidden).includes('Alex Tan'));

  // Admin list: masked IC only, never the blob.
  const a = K.adminEntrant(ko.categories[0].entrants[0]);
  check('admin list masks the IC', a.players[0].ic === '••••5511');
  check('admin list never carries the encrypted blob', !JSON.stringify(a).includes('icEnc'));
  check('admin list keeps the phone (admins must call people)', a.players[0].phone === '0123456789');
  check('admin list flags that an IC is on file', a.players[0].hasIC === true);
}

// ── the public shape must render a real bracket ──────────────────────
// Regression: the public projection strips `players` (they carry phones and
// ICs) and hands over a precomputed `label` instead. Anything that reads names
// off `players` renders a screen full of "TBC".
{
  const stored = { event: { name: 'E', published: true }, categories: [{
    id: 'c', name: 'MD', type: 'doubles', code: 'ABCDEF', status: 'drawn', entrants: [
      { id: 'e1', status: 'confirmed', at: 1, seed: 1, players: [
        { name: 'Alex Tan', phone: '0123456789', club: 'TZH', icLast4: '5511' },
        { name: 'Wei Ming', phone: '0129876543', club: 'TZH', icLast4: '5522' } ] },
      { id: 'e2', status: 'confirmed', at: 2, seed: 2, players: [
        { name: 'Sam Lee', phone: '0111111111', club: '' },
        { name: 'Jo Ng', phone: '0122222222', club: '' } ] },
      { id: 'e3', status: 'confirmed', at: 3, seed: 3, players: [
        { name: 'Raj Kumar', phone: '0133333333', club: 'Penang SC' },
        { name: 'Ben Ooi', phone: '0144444444', club: 'Penang SC' } ] } ] }] };
  const cat = K.normalizeCategory(stored.categories[0]);
  stored.categories[0].draw = K.buildDraw(cat, { nowMs: 1 }).draw;

  const priv = K.viewOf(stored.categories[0]);
  check('private view names its matches', priv.matches.some((m) => m.aLabel === 'Alex Tan & Wei Ming'));

  const pubCat = K.publicKnockout(stored).categories[0];
  check('public entrants carry a label but no players', !!pubCat.entrants[0].label && pubCat.entrants[0].players === undefined);
  const pub = K.viewOf(pubCat);
  check('public view names its matches too', pub.matches.some((m) => m.aLabel === 'Alex Tan & Wei Ming'));
  check('public view shows nobody as TBC who is actually known',
    pub.matches.filter((m) => m.round === 1 && !m.bye).every((m) => m.aLabel !== 'TBC' && m.bLabel !== 'TBC'));
  check('public view keeps the club', pub.matches.some((m) => m.aClub === 'TZH' || m.bClub === 'TZH'));
  check('public and private brackets agree on every label',
    JSON.stringify(pub.matches.map((m) => [m.aLabel, m.bLabel])) === JSON.stringify(priv.matches.map((m) => [m.aLabel, m.bLabel])));
  check('a future round is still honestly TBC', pub.matches.some((m) => m.round > 1 && m.aLabel === 'TBC'));

  // Same for a round-robin table, which reads the entrant list directly.
  const rrStored = JSON.parse(JSON.stringify(stored));
  rrStored.categories[0].format = 'roundrobin';
  rrStored.categories[0].draw = K.buildDraw(K.normalizeCategory(rrStored.categories[0]), { nowMs: 1 }).draw;
  const rrPub = K.viewOf(K.publicKnockout(rrStored).categories[0]);
  check('public standings name their rows', rrPub.table.length === 3 && rrPub.table.every((r) => r.label && r.label !== 'TBC'));

  check('labelOf reads either shape', K.labelOf({ label: 'A & B' }) === 'A & B' && K.labelOf({ players: [{ name: 'A' }, { name: 'B' }] }) === 'A & B');
  check('clubOf reads either shape', K.clubOf({ club: 'TZH' }) === 'TZH' && K.clubOf({ players: [{ name: 'A', club: 'TZH' }] }) === 'TZH');
}

// ── normalize / codes ────────────────────────────────────────────────
{
  check('normalize(null) gives an empty event', K.normalize(null).categories.length === 0);
  check('normalize survives junk', K.normalize({ categories: 'nope', event: 5 }).categories.length === 0);
  const dup = K.normalize({ event: { name: 'E' }, categories: [
    { id: 'a', name: 'A', code: 'SAME' }, { id: 'b', name: 'B', code: 'same' } ] });
  check('a duplicate code is cleared, never ambiguous', dup.categories[1].code === '');
  check('the first category keeps its code', dup.categories[0].code === 'SAME');
  check('codes normalise case and punctuation', K.normCode('md-open ') === 'MDOPEN');
  check('a short code is invalid', K.isValidCode('AB') === false);
  check('a six-character code is valid', K.isValidCode('MDOPEN') === true);
  const ko = { event: { name: 'E' }, categories: [{ id: 'a', name: 'A', code: 'TAKEN' }] };
  check('codeTaken spots a clash', K.codeTaken(ko, 'taken') === true);
  check('codeTaken ignores the category itself', K.codeTaken(ko, 'TAKEN', 'a') === false);
  check('freshCode avoids a clash', K.freshCode(ko) !== 'TAKEN');
  check('generated codes avoid ambiguous characters', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(K.genCode()));
}
{
  const ko = { event: { name: 'E', regOpen: true, published: true }, categories: [
    { id: 'a', name: 'A', code: 'AAAAAA', status: 'open' },
    { id: 'b', name: 'B', code: 'BBBBBB', status: 'closed' } ] };
  check('findByCode finds an open category', (K.findByCode(ko, 'aaaaaa') || {}).id === 'a');
  check('findByCode tolerates spacing and dashes', (K.findByCode(ko, ' AAA-AAA ') || {}).id === 'a');
  check('findByCode misses an unknown code', K.findByCode(ko, 'ZZZZZZ') === null);
  check('findByCode on empty input is null', K.findByCode(ko, '') === null);
}

// ── admin counts ─────────────────────────────────────────────────────
{
  const ko = { event: { name: 'E' }, categories: [{ id: 'c', name: 'C', type: 'doubles', status: 'open', entrants: [
    { id: 'e1', status: 'pending', players: [{ name: 'A' }, { name: 'B' }] },
    { id: 'e2', status: 'confirmed', paid: false, players: [{ name: 'C' }, { name: 'D' }] },
    { id: 'e3', status: 'confirmed', paid: true, players: [{ name: 'E' }, { name: 'F' }] },
    { id: 'e4', status: 'withdrawn', players: [{ name: 'G' }, { name: 'H' }] } ] }] };
  check('todoCount counts pending + unpaid', K.todoCount(ko) === 2);
  const s = K.summary(ko.categories[0]);
  check('summary counts confirmed', s.confirmed === 2);
  check('summary counts pending', s.pending === 1);
  check('summary counts unpaid', s.unpaid === 1);
  check('summary picks the effective format', s.format === 'roundrobin' && s.formatLabel === 'Round robin');
  check('summary reports byes for a knockout', K.summary({ id: 'x', name: 'X', format: 'knockout', type: 'singles', entrants: Array.from({ length: 20 }, (_, i) => ({ id: 'e' + i, status: 'confirmed', players: [{ name: 'p' }] })) }).byes === 12);
}

// ── nothing throws on rubbish ────────────────────────────────────────
for (const junk of [null, undefined, 0, '', [], { categories: null }]) {
  try {
    K.normalize(junk); K.publicKnockout(junk); K.todoCount(junk); K.categoriesOf(junk); K.findByCode(junk, 'X');
    pass++;
  } catch (e) { fail++; console.log('  FAIL  throws on junk input: ' + JSON.stringify(junk)); }
}
try { K.resolveDraw(null); K.standings(null, null); K.buildDraw(null, null); pass++; }
catch (e) { fail++; console.log('  FAIL  draw helpers throw on null'); }

console.log(`\nknockout tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
