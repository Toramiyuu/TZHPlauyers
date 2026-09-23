/*
 * matchmaking.js — pure logic for level-balanced schedule generation.
 * Loaded in the browser via <script src> (window.Matchmaking) and required by Node tests.
 * No dependencies, no build step.
 *
 * A doubles TEAM's strength is the SUM of its two players' levels (1.0–7.0). Two
 * teams may meet when their sums are within ±0.5 of each other. That is a strong
 * preference, not a hard wall: every round is always filled with the closest
 * opponents available, and courts whose team sums differ by more than 0.5 are
 * flagged (by the admin UI) so they can be hand-tweaked.
 *
 * Unrated players and guests (no roster entry, or no level) count as 4.0 — the
 * midpoint of the scale — so balancing never blocks on missing data.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.Matchmaking = api;                                          // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNRATED = 4.0;      // level for unrated players / guests (scale midpoint)
  const TOL = 0.5;          // ± team-sum tolerance for a "balanced" court
  const W_VARIETY = 2.5;    // weight of the partner-variety term vs the level term

  /**
   * Round a raw level input to the nearest 0.5, clamped to 1–7. Blank/NaN → null
   * (clears the level). Returned as a Number (caller stringifies for storage).
   */
  function roundLevel(value) {
    const s = (value == null ? '' : String(value)).trim();
    if (s === '') return null;
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return Math.round(Math.min(7, Math.max(1, n)) * 2) / 2;
  }

  /** Read a player's level from their meta entry; missing/NaN → 4.0. */
  function levelOf(id, metaById) {
    const m = metaById && metaById[id];
    if (!m) return UNRATED;
    const lv = parseFloat(m.level);
    return isNaN(lv) ? UNRATED : lv;
  }

  function isGirl(id, metaById) {
    const m = metaById && metaById[id];
    return !!(m && m.girl);
  }
  function isMixedEligible(id, metaById) {
    const m = metaById && metaById[id];
    return !!(m && m.mixed);
  }

  /**
   * Live balance info for a court (4 ids, empty/unknown allowed). Pure; never
   * throws on '' / missing ids (they count as 4.0). `bothMixed` is true when each
   * team is exactly one girl + one guy (a real mixed-doubles court).
   */
  function courtBalanceInfo(court, metaById) {
    const c = court || {};
    const t1 = c.team1 || [];
    const t2 = c.team2 || [];
    const lv = (id) => levelOf(id, metaById);
    const sum1 = lv(t1[0]) + lv(t1[1]);
    const sum2 = lv(t2[0]) + lv(t2[1]);
    const teamMixed = (t) => {
      const g = (isGirl(t[0], metaById) ? 1 : 0) + (isGirl(t[1], metaById) ? 1 : 0);
      return g === 1; // exactly one girl + one guy
    };
    return {
      sum1,
      sum2,
      gap: Math.abs(sum1 - sum2),
      bothMixed: teamMixed(t1) && teamMixed(t2),
    };
  }

  /**
   * Pick the best partner for `a` from `pool` (array of player indices), toward a
   * common team-sum `target`, favouring pairs that have partnered least. Returns
   * the chosen pool index (position in `pool`), or -1 if the pool is empty.
   */
  function bestPartnerIdx(a, pool, levels, partnerCount, target) {
    let bestPos = -1, bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      const score = W_VARIETY * partnerCount[a][b] + Math.abs(levels[a] + levels[b] - target);
      if (score < bestScore) { bestScore = score; bestPos = i; }
    }
    return bestPos;
  }

  /**
   * Level-balanced schedule generator. Same signature/behaviour contract as the
   * old smartSchedule, plus a `metaById` map (id -> {level, girl, mixed}). Pure —
   * no DOM/state reads. Selection (rest rotation + play-count fairness) and the
   * partner-variety bookkeeping are preserved exactly; only the pairing and the
   * court (pair-vs-pair) matching are level-aware.
   *
   * Output shape is unchanged: [{ label, courts:[{ team1:[id,id], team2:[id,id] }] }].
   * No balance/mixed flags are stored on the court — the admin UI recomputes them
   * live via courtBalanceInfo so manual edits can't leave stale metadata.
   */
  function smartSchedule(players, numCourts, numRounds, metaById) {
    const n = players.length;
    const perRound = Math.min(numCourts * 4, Math.floor(n / 4) * 4);
    const activeCourts = perRound / 4;
    const meta = metaById || {};

    // Per-index level (parallel to players), so pairing math is index-based.
    const levels = players.map((p) => levelOf(p.id, meta));
    const girlFlag = players.map((p) => isGirl(p.id, meta));
    const mixedFlag = players.map((p) => isMixedEligible(p.id, meta));

    const lastPlayed = new Array(n).fill(-999);
    const playCount = new Array(n).fill(0);
    const partnerCount = Array.from({ length: n }, () => new Array(n).fill(0));
    const rounds = [];

    for (let r = 0; r < numRounds; r++) {
      // ── Selection (unchanged): rest-gap first, then play-count, then index ──
      const ranking = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
        const ra = r - lastPlayed[a], rb = r - lastPlayed[b];
        if (rb !== ra) return rb - ra;
        if (playCount[a] !== playCount[b]) return playCount[a] - playCount[b];
        return a - b;
      });
      const selected = ranking.slice(0, perRound);

      // Target team sum = 2 × mean level of the selected players. Pairing toward
      // this common target naturally puts strong players with weak ones, which is
      // what makes ±0.5 opponent matches achievable.
      const meanLvl = selected.reduce((s, i) => s + levels[i], 0) / (selected.length || 1);
      const target = 2 * meanLvl;

      // Pools for the three-pass, constraint-aware pairing.
      const girlsOff = selected.filter((i) => girlFlag[i] && !mixedFlag[i]);
      const girlsOn = selected.filter((i) => girlFlag[i] && mixedFlag[i]);
      const guys = selected.filter((i) => !girlFlag[i]);
      const remove = (arr, v) => { const k = arr.indexOf(v); if (k >= 0) arr.splice(k, 1); };

      const pairs = []; // { idx:[a,b], mixed:Boolean }

      // ── Pass A — girls with Mixed OFF: partner with another girl (any girl). ──
      // Relax to a guy only if literally no girl partner is free.
      while (girlsOff.length) {
        const a = girlsOff.shift();
        // Prefer another Mixed-OFF girl, else a Mixed-ON girl, else (last resort) a guy.
        let pool = girlsOff, fromGuys = false;
        if (!pool.length) pool = girlsOn;
        if (!pool.length) { pool = guys; fromGuys = true; }
        if (!pool.length) { pairs.push({ idx: [a], mixed: false }); break; }
        const pos = bestPartnerIdx(a, pool, levels, partnerCount, target);
        const b = pool[pos];
        pool.splice(pos, 1);
        pairs.push({ idx: [a, b], mixed: fromGuys });
      }

      // ── Pass B — girls with Mixed ON: partner with a guy (mixed pair). ──
      // If guys run out, remaining Mixed-ON girls pair together.
      while (girlsOn.length) {
        const a = girlsOn.shift();
        if (guys.length) {
          const pos = bestPartnerIdx(a, guys, levels, partnerCount, target);
          const b = guys[pos];
          guys.splice(pos, 1);
          pairs.push({ idx: [a, b], mixed: true });
        } else if (girlsOn.length) {
          const pos = bestPartnerIdx(a, girlsOn, levels, partnerCount, target);
          const b = girlsOn[pos];
          girlsOn.splice(pos, 1);
          pairs.push({ idx: [a, b], mixed: false });
        } else {
          pairs.push({ idx: [a], mixed: false });
        }
      }

      // ── Pass C — everyone left (guys, or a stray leftover): pair by score. ──
      const rest = [...guys];
      while (rest.length >= 2) {
        const a = rest.shift();
        const pos = bestPartnerIdx(a, rest, levels, partnerCount, target);
        const b = rest[pos];
        rest.splice(pos, 1);
        pairs.push({ idx: [a, b], mixed: false });
      }
      // A trailing odd player (only possible via cross-pass relaxations) is kept
      // as a singleton so it gets folded below — never silently dropped.
      if (rest.length === 1) pairs.push({ idx: [rest[0]], mixed: false });

      // Fold any singletons (odd pools across passes) into complete pairs so the
      // court count is always exact. perRound is a multiple of 4, so the total
      // number of selected players is even — singletons only ever come in twos.
      const singles = pairs.filter((p) => p.idx.length === 1);
      const full = pairs.filter((p) => p.idx.length === 2);
      for (let i = 0; i + 1 < singles.length; i += 2) {
        const a = singles[i].idx[0], b = singles[i + 1].idx[0];
        full.push({ idx: [a, b], mixed: (girlFlag[a] ? 1 : 0) + (girlFlag[b] ? 1 : 0) === 1 });
      }

      // Record partnerships for variety — once per final pair (used next round).
      for (const p of full) {
        const [a, b] = p.idx;
        partnerCount[a][b]++; partnerCount[b][a]++;
      }

      // ── Court matching (pair vs pair): mixed pairs meet mixed pairs first. ──
      const mixedPairs = full.filter((p) => p.mixed).sort((x, y) => sumOf(x, levels) - sumOf(y, levels));
      const otherPairs = full.filter((p) => !p.mixed);

      const matched = []; // ordered list of pairs, consumed 2-at-a-time into courts
      for (let i = 0; i + 1 < mixedPairs.length; i += 2) {
        matched.push(mixedPairs[i], mixedPairs[i + 1]);
      }
      // An odd mixed pair falls into the general pool.
      if (mixedPairs.length % 2 === 1) otherPairs.push(mixedPairs[mixedPairs.length - 1]);

      otherPairs.sort((x, y) => sumOf(x, levels) - sumOf(y, levels));
      for (const p of otherPairs) matched.push(p);

      // ── Build courts from the matched pairs (two pairs per court). ──
      const courts = [];
      for (let c = 0; c < activeCourts; c++) {
        const [a, b] = matched[c * 2].idx;
        const [d, e] = matched[c * 2 + 1].idx;
        courts.push({
          team1: [players[a].id, players[b].id],
          team2: [players[d].id, players[e].id],
        });
      }

      selected.forEach((i) => { lastPlayed[i] = r; playCount[i]++; });
      rounds.push({ label: `Round ${r + 1}`, courts });
    }

    return rounds;
  }

  function sumOf(pair, levels) {
    return pair.idx.reduce((s, i) => s + levels[i], 0);
  }

  // ── Filling ONE round's blanks ───────────────────────────────────
  // The whole-schedule generator above replaces everything. What an organiser
  // actually does mid-session is arrange a court or two by hand and want the
  // rest filled in — and filled with whoever has been sitting out longest,
  // which the wholesale generator has no way to know (it re-derives its own
  // rest rotation from scratch and cannot see who walked in late).

  /** Slots holding no known player, court-major, Team A before Team B. Pure. */
  function emptySlotsOf(round, isKnown) {
    const known = typeof isKnown === 'function' ? isKnown : (id) => !!id;
    const out = [];
    const courts = (round && round.courts) || [];
    for (let c = 0; c < courts.length; c++) {
      const ct = courts[c] || {};
      for (const team of ['team1', 'team2']) {
        const arr = ct[team] || [];
        for (let k = 0; k < 2; k++) {
          const id = arr[k];
          if (!id || !known(id)) out.push({ court: c, team, index: k });
        }
      }
    }
    return out;
  }

  /** Every ordering of a short list. Only ever called with ≤ 4 items. Pure. */
  function permutations(list) {
    if (list.length <= 1) return [list.slice()];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const rest = list.slice(0, i).concat(list.slice(i + 1));
      for (const p of permutations(rest)) out.push([list[i]].concat(p));
    }
    return out;
  }

  /**
   * Fill a round's EMPTY slots from `candidates`, an ordered list of ids with
   * the strongest claim to the next game first (longest wait — the caller
   * decides and is responsible for leaving out anyone who has gone home).
   *
   * Two separate decisions, deliberately:
   *   WHO plays  — strictly the candidate order, so the fairness the caller
   *                computed is never quietly traded away for a neater court.
   *   WHERE they go — chosen to bring each court's two team sums together.
   *
   * Anyone already placed stays exactly where they are: this only ever writes
   * into blanks, so a hand-arranged court survives the button untouched. Pure.
   * Returns { courts, placed, filled, short }.
   */
  function fillRound(round, candidates, metaById, isKnown) {
    const meta = metaById || {};
    const courts = ((round && round.courts) || []).map((ct) => ({
      team1: [(ct && ct.team1 && ct.team1[0]) || '', (ct && ct.team1 && ct.team1[1]) || ''],
      team2: [(ct && ct.team2 && ct.team2[0]) || '', (ct && ct.team2 && ct.team2[1]) || ''],
    }));
    const slots = emptySlotsOf({ courts }, isKnown);

    // Never place someone twice, and never place someone the round already has.
    const taken = new Set();
    for (const ct of courts) {
      for (const team of ['team1', 'team2']) for (const id of ct[team]) if (id) taken.add(id);
    }
    const picks = [];
    for (const id of (candidates || [])) {
      if (!id || taken.has(id)) continue;
      taken.add(id);
      picks.push(id);
      if (picks.length >= slots.length) break;
    }

    // Spread the level range across the courts — strongest, weakest, next
    // strongest… — so no court is handed only the bottom of the pool.
    const byLevel = picks.slice().sort((a, b) =>
      levelOf(b, meta) - levelOf(a, meta) || String(a).localeCompare(String(b)));
    const dealt = [];
    let lo = 0, hi = byLevel.length - 1, takeHigh = true;
    while (lo <= hi) { dealt.push(takeHigh ? byLevel[lo++] : byLevel[hi--]); takeHigh = !takeHigh; }

    const placed = [];
    let cursor = 0;
    for (let c = 0; c < courts.length; c++) {
      const mine = slots.filter((s) => s.court === c);
      if (!mine.length) continue;
      const take = dealt.slice(cursor, cursor + mine.length);
      cursor += take.length;
      if (!take.length) continue;
      let best = null, bestGap = Infinity;
      for (const perm of permutations(take)) {
        const trial = { team1: courts[c].team1.slice(), team2: courts[c].team2.slice() };
        perm.forEach((id, idx) => { const s = mine[idx]; if (s) trial[s.team][s.index] = id; });
        const gap = courtBalanceInfo(trial, meta).gap;
        if (gap < bestGap - 1e-9) { bestGap = gap; best = perm; }
      }
      (best || take).forEach((id, idx) => {
        const s = mine[idx];
        if (!s) return;
        courts[c][s.team][s.index] = id;
        placed.push({ id, court: c, team: s.team, index: s.index });
      });
    }

    return { courts, placed, filled: placed.length, short: slots.length - placed.length };
  }

  // ── Session pair history (repeat-matchup warnings) ──────────────
  // How often each pair of players has been partners / opponents across a
  // session's rounds. Keys are 'idA|idB' with the ids sorted, so lookups are
  // order-independent.
  function pairKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }
  function pairCounts(rounds) {
    const partner = {}, opponent = {};
    const bump = (m, a, b) => { if (a && b && a !== b) m[pairKey(a, b)] = (m[pairKey(a, b)] || 0) + 1; };
    (rounds || []).forEach(r => (r?.courts || []).forEach(ct => {
      const t1 = ct?.team1 || [], t2 = ct?.team2 || [];
      bump(partner, t1[0], t1[1]);
      bump(partner, t2[0], t2[1]);
      t1.forEach(a => t2.forEach(b => bump(opponent, a, b)));
    }));
    return { partner, opponent };
  }
  // Messages for one court whose pairs repeat more than `threshold` (default 3)
  // times in the session, e.g. "Thomas has partnered Desmond 4 times".
  function courtPairWarnings(court, counts, nameOf, threshold) {
    const th = (typeof threshold === 'number') ? threshold : 3;
    const out = [];
    const seen = new Set();
    const chk = (a, b, m, verb) => {
      if (!a || !b || a === b) return;
      const k = verb + ':' + pairKey(a, b);
      if (seen.has(k)) return;
      seen.add(k);
      const n = m[pairKey(a, b)] || 0;
      if (n > th) out.push(nameOf(a) + ' has ' + verb + ' ' + nameOf(b) + ' ' + n + ' times');
    };
    const t1 = court?.team1 || [], t2 = court?.team2 || [];
    chk(t1[0], t1[1], counts.partner, 'partnered');
    chk(t2[0], t2[1], counts.partner, 'partnered');
    t1.forEach(a => t2.forEach(b => chk(a, b, counts.opponent, 'played against')));
    return out;
  }

  return {
    UNRATED,
    TOL,
    W_VARIETY,
    roundLevel,
    levelOf,
    courtBalanceInfo,
    smartSchedule,
    emptySlotsOf,
    permutations,
    fillRound,
    pairKey,
    pairCounts,
    courtPairWarnings,
  };
});
