/*
 * monthly-lucky.js — pure logic for the Monthly Lucky Draw (points-based).
 * Loaded in the browser via <script src> (window.MonthlyLucky) and required by
 * lib/monthly-lucky.js + the Node tests. Depends only on session-draw.js for the
 * seeded Fisher–Yates shuffle so every monthly draw is verifiable the same way.
 * No DOM, no clock, no randomness of its own: `nowMs` / `todayISO` / `seed` are
 * ALWAYS injected so every function is deterministic under test.
 *
 * Rules:
 *   - Roster points belong to ONE calendar month (monthlyLucky.pointsMonth). The
 *     first time the server sees a later month it CLOSES the old one: every
 *     player's points are snapshotted into monthlyLucky.closed[month] and reset to
 *     0 (closeIfDue). Points therefore start from zero each month.
 *   - Eligible = roster players with points >= threshold (default 80).
 *   - Automatic draw: when `auto` is on, a closed month is drawn at DRAW_TIME
 *     Malaysia time on the 1st of the following month (scheduledDrawAt) from the
 *     closed snapshot. With `auto` off the month waits for an admin.
 *   - Manual draw ("Run draw now"): the CURRENT month can be drawn any time from
 *     the pulled pool (roster >= threshold, minus anyone the admin removed); a
 *     closed month uses its snapshot minus the same removals.
 *   - Winners = first N of the seeded shuffle of the eligible ids; winner k gets
 *     prize k (extra winners win with no named prize). One record per month,
 *     permanent (HSETNX in lib/monthly-lucky.js).
 *   - A prize is { id, name, qty, desc, photo }: `qty` (1..MAX_PRIZE_QTY) lets one
 *     winner take several of the same item ("2 × Tube of shuttlecocks"), `desc`
 *     is an optional short description. Name/qty/desc are snapshotted into the
 *     record; photos are looked up live by prize id.
 */
(function (root, factory) {
  const dep = (root && root.SessionDraw) || (typeof require === 'function' ? require('./session-draw.js') : null);
  const api = factory(dep);
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.MonthlyLucky = api;                                         // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SD) {
  'use strict';

  // ── config ───────────────────────────────────────────────────────────
  const DRAW_TIME = '09:00';            // wall-clock (Asia/Kuala_Lumpur) on the 1st of the next month
  const DEFAULT_THRESHOLD = 80, MIN_THRESHOLD = 1, MAX_THRESHOLD = 10000;
  const DEFAULT_WINNERS = 3, MIN_WINNERS = 1, MAX_WINNERS = 20;
  const MAX_PRIZES = 12, MAX_PRIZE_NAME = 60, MAX_PRIZE_DESC = 200;
  const DEFAULT_PRIZE_QTY = 1, MIN_PRIZE_QTY = 1, MAX_PRIZE_QTY = 99;
  const MAX_PHOTO_BYTES = 200 * 1024;   // data-URL length cap for one prize photo
  const KEEP_CLOSED_MONTHS = 12;
  const ALGORITHM = 'sfc32-fisher-yates-v1';
  const RECORD_VERSION = 1;
  const DEFAULT_OFFSET_HOURS = 8;
  const MONTH_RE = /^(\d{4})-(\d{2})$/;
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ── month helpers ────────────────────────────────────────────────────
  function isMonthKey(m) { const x = MONTH_RE.exec(String(m || '')); return !!x && +x[2] >= 1 && +x[2] <= 12; }
  function monthKeyOf(iso) { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? m[1] + '-' + m[2] : ''; }
  function monthLabel(m) { const x = MONTH_RE.exec(String(m || '')); return x && MONTHS_LONG[+x[2] - 1] ? MONTHS_LONG[+x[2] - 1] + ' ' + x[1] : String(m || ''); }
  function shiftMonthKey(m, delta) {
    const x = MONTH_RE.exec(String(m || ''));
    if (!x) return String(m || '');
    const total = (+x[1]) * 12 + (+x[2] - 1) + (Math.trunc(Number(delta)) || 0);
    const y = Math.floor(total / 12), mo = ((total % 12) + 12) % 12;
    return y + '-' + String(mo + 1).padStart(2, '0');
  }
  function nextMonthKey(m) { return shiftMonthKey(m, 1); }
  function prevMonthKey(m) { return shiftMonthKey(m, -1); }
  /** Calendar year of a month key, or 0 when it is not one. */
  function yearOf(m) { const x = MONTH_RE.exec(String(m || '')); return x ? +x[1] : 0; }
  /**
   * The twelve cells of one year, for the Monthly record calendar. The session
   * draw happens on a day, so its calendar is a day grid; this draw happens to a
   * MONTH, so its grid is Jan..Dec of one year. Pure: no clock, no DOM.
   * @returns {{year:number, cells:{month:string, short:string, long:string}[]}}
   */
  function monthYearGrid(year) {
    const y = Math.trunc(Number(year)) || 0;
    return {
      year: y,
      cells: MONTHS_LONG.map((long, i) => ({
        month: y + '-' + String(i + 1).padStart(2, '0'),
        short: long.slice(0, 3),
        long,
      })),
    };
  }
  /** ISO date of the day the draw for `month` happens (1st of the following month). */
  function drawDateFor(month) { return isMonthKey(month) ? nextMonthKey(month) + '-01' : null; }
  /** Epoch ms of the scheduled automatic draw for `month`, or null. */
  function scheduledDrawAt(month, offsetHours) {
    const d = drawDateFor(month);
    return d ? SD.mytInstant(d, DRAW_TIME, offsetHours) : null;
  }
  /** Month key (Malaysia time) of an epoch instant. */
  function monthOfInstant(ms, offsetHours) {
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    const d = new Date((Number(ms) || 0) + off * 3600 * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  function isoOfInstant(ms, offsetHours) {
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    return new Date((Number(ms) || 0) + off * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ── settings ─────────────────────────────────────────────────────────
  function isWinnersCount(n) { return Number.isInteger(n) && n >= MIN_WINNERS && n <= MAX_WINNERS; }
  function isThreshold(n) { return Number.isInteger(n) && n >= MIN_THRESHOLD && n <= MAX_THRESHOLD; }
  function isPrizeQty(n) { return Number.isInteger(n) && n >= MIN_PRIZE_QTY && n <= MAX_PRIZE_QTY; }
  function isPhoto(s) { return typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= MAX_PHOTO_BYTES; }
  function newPrizeId(seedStr) {
    // Deterministic-friendly: callers pass an id when they have one; this is only for brand-new rows.
    return 'pz' + String(seedStr || Date.now().toString(36)) + Math.random().toString(36).slice(2, 6);
  }
  /** Which place a prize goes to. Several prizes may share one place; a prize
   *  saved before this existed keeps its old positional meaning (row 1 -> 1st). */
  function isPlace(n) { return Number.isInteger(n) && n >= 1 && n <= MAX_PRIZES; }
  function placeOf(p, index) {
    const n = p && p.place != null ? Number(p.place) : NaN;
    return isPlace(n) ? n : (Number(index) || 0) + 1;
  }
  /** Clean prize list: trimmed names (required), qty 1..MAX_PRIZE_QTY (default 1), trimmed optional desc, optional photo, stable ids, max MAX_PRIZES. */
  function normalizePrizes(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((p, i) => {
      if (!p || typeof p !== 'object' || out.length >= MAX_PRIZES) return;
      const name = String(p.name == null ? '' : p.name).trim().slice(0, MAX_PRIZE_NAME);
      if (!name) return;
      let id = typeof p.id === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(p.id) ? p.id : ('pz' + (i + 1));
      while (seen.has(id)) id += 'x';
      seen.add(id);
      const qty = isPrizeQty(Number(p.qty)) ? Number(p.qty) : DEFAULT_PRIZE_QTY;
      const desc = String(p.desc == null ? '' : p.desc).trim().slice(0, MAX_PRIZE_DESC);
      out.push({ id, name, qty, desc, place: placeOf(p, out.length), photo: isPhoto(p.photo) ? p.photo : null });
    });
    return out;
  }
  /** Display label for a prize: "Name" or "3 × Name" when the quantity is above one. */
  function prizeLabel(p) {
    if (!p || typeof p !== 'object') return '';
    const name = String(p.name == null ? '' : p.name).trim();
    const qty = isPrizeQty(Number(p.qty)) ? Number(p.qty) : DEFAULT_PRIZE_QTY;
    return !name ? '' : qty > 1 ? qty + ' × ' + name : name;
  }
  /** Validated settings from state.monthlyLucky (defaults for anything missing/junk). */
  function settingsOf(state) {
    const ml = state && state.monthlyLucky && typeof state.monthlyLucky === 'object' ? state.monthlyLucky : {};
    return {
      auto: ml.auto === undefined ? true : !!ml.auto,
      winners: isWinnersCount(Number(ml.winners)) ? Number(ml.winners) : DEFAULT_WINNERS,
      threshold: isThreshold(Number(ml.threshold)) ? Number(ml.threshold) : DEFAULT_THRESHOLD,
      prizes: normalizePrizes(ml.prizes),
    };
  }
  /** Full normalized monthlyLucky blob (settings + pointsMonth + pool + closed). */
  function normalize(ml, todayISO) {
    const src = ml && typeof ml === 'object' ? ml : {};
    const s = settingsOf({ monthlyLucky: src });
    const pool = src.pool && typeof src.pool === 'object' && isMonthKey(src.pool.month) ? {
      month: src.pool.month, pulledAt: Number(src.pool.pulledAt) || 0,
      players: (Array.isArray(src.pool.players) ? src.pool.players : []).filter((p) => p && p.id).map((p) => ({ id: String(p.id), name: String(p.name || p.id), points: Number(p.points) || 0 })),
      removed: (Array.isArray(src.pool.removed) ? src.pool.removed : []).map(String),
    } : null;
    const closed = {};
    const c = src.closed && typeof src.closed === 'object' ? src.closed : {};
    Object.keys(c).filter(isMonthKey).sort().slice(-KEEP_CLOSED_MONTHS).forEach((m) => {
      const e = c[m] || {};
      closed[m] = { month: m, closedAt: Number(e.closedAt) || 0, points: e.points && typeof e.points === 'object' ? e.points : {}, names: e.names && typeof e.names === 'object' ? e.names : {} };
    });
    return {
      auto: s.auto, winners: s.winners, threshold: s.threshold, prizes: s.prizes,
      pointsMonth: isMonthKey(src.pointsMonth) ? src.pointsMonth : monthKeyOf(todayISO),
      pool, closed,
    };
  }
  /** What rides the 2s poll: settings without photo bytes, no snapshots. */
  function liteOf(ml, todayISO) {
    const n = normalize(ml, todayISO);
    return {
      auto: n.auto, winners: n.winners, threshold: n.threshold, pointsMonth: n.pointsMonth,
      prizes: n.prizes.map((p) => ({ id: p.id, name: p.name, qty: p.qty, desc: p.desc, place: p.place, hasPhoto: !!p.photo })),
      pool: n.pool ? { month: n.pool.month, pulledAt: n.pool.pulledAt, count: n.pool.players.length, removed: n.pool.removed.slice() } : null,
    };
  }

  // ── eligibility ──────────────────────────────────────────────────────
  function byPointsThenName(a, b) { return (b.points - a.points) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }); }
  /** Roster players at or above the threshold: [{id,name,points}] best first. */
  function eligibleFromRoster(roster, threshold) {
    const t = isThreshold(Number(threshold)) ? Number(threshold) : DEFAULT_THRESHOLD;
    return (Array.isArray(roster) ? roster : [])
      .filter((r) => r && r.id && (Number(r.points) || 0) >= t)
      .map((r) => ({ id: String(r.id), name: String(r.name || r.id), points: Number(r.points) || 0 }))
      .sort(byPointsThenName);
  }
  /** Same, from a closed-month snapshot {points:{id:n}, names:{id:name}}. */
  function eligibleFromSnapshot(snap, threshold) {
    const t = isThreshold(Number(threshold)) ? Number(threshold) : DEFAULT_THRESHOLD;
    const pts = snap && snap.points && typeof snap.points === 'object' ? snap.points : {};
    const names = snap && snap.names ? snap.names : {};
    return Object.keys(pts)
      .filter((id) => (Number(pts[id]) || 0) >= t)
      .map((id) => ({ id, name: String(names[id] || id), points: Number(pts[id]) || 0 }))
      .sort(byPointsThenName);
  }
  /** Drop removed ids (admin curation) from an eligible list. */
  function applyRemoved(list, removed) {
    const rm = new Set((Array.isArray(removed) ? removed : []).map(String));
    return (list || []).filter((p) => !rm.has(String(p.id)));
  }
  /** Fresh pool for the current month from the live roster. */
  function buildPool(state, month, nowMs) {
    const s = settingsOf(state);
    const ml = state && state.monthlyLucky ? state.monthlyLucky : {};
    const prev = ml.pool && ml.pool.month === month ? ml.pool : null;
    const players = eligibleFromRoster(state && state.roster, s.threshold);
    const ids = new Set(players.map((p) => p.id));
    const removed = prev && Array.isArray(prev.removed) ? prev.removed.map(String).filter((id) => ids.has(id)) : [];
    return { month, pulledAt: Number(nowMs) || 0, players, removed };
  }
  /** Players who reached the threshold since the pool was pulled (for the "pull again" hint). */
  function poolStaleIds(state, pool) {
    if (!pool) return [];
    const now = eligibleFromRoster(state && state.roster, settingsOf(state).threshold);
    const had = new Set((pool.players || []).map((p) => String(p.id)));
    return now.filter((p) => !had.has(p.id)).map((p) => p.id);
  }

  // ── month close (points reset) ───────────────────────────────────────
  function closeDue(state, todayISO) {
    const ml = normalize(state && state.monthlyLucky, todayISO);
    const cur = monthKeyOf(todayISO);
    return isMonthKey(cur) && ml.pointsMonth < cur ? ml.pointsMonth : null;
  }
  /**
   * Close every month behind `todayISO`. Pure: returns { changed, state, closedMonths }
   * with a NEW state object whose roster points are 0 and whose monthlyLucky.closed
   * carries the final points of the month(s) just closed. A blob with no
   * pointsMonth is stamped with the current month (no reset) — that is how an
   * existing deployment migrates without wiping anyone.
   */
  function closeIfDue(state, todayISO, nowMs) {
    const s = state || {};
    const cur = monthKeyOf(todayISO);
    const ml = normalize(s.monthlyLucky, todayISO);
    const hadKey = !!(s.monthlyLucky && isMonthKey(s.monthlyLucky.pointsMonth));
    if (!isMonthKey(cur)) return { changed: false, state: s, closedMonths: [] };
    if (!hadKey) return { changed: true, state: Object.assign({}, s, { monthlyLucky: Object.assign({}, ml, { pointsMonth: cur }) }), closedMonths: [] };
    if (ml.pointsMonth >= cur) return { changed: false, state: s, closedMonths: [] };
    const roster = Array.isArray(s.roster) ? s.roster : [];
    const points = {}, names = {};
    roster.forEach((r) => { if (r && r.id) { points[r.id] = Number(r.points) || 0; names[r.id] = String(r.name || r.id); } });
    const closed = Object.assign({}, ml.closed, { [ml.pointsMonth]: { month: ml.pointsMonth, closedAt: Number(nowMs) || 0, points, names } });
    const keys = Object.keys(closed).sort().slice(-KEEP_CLOSED_MONTHS);
    const kept = {}; keys.forEach((k) => { kept[k] = closed[k]; });
    const next = Object.assign({}, s, {
      roster: roster.map((r) => (r && r.id ? Object.assign({}, r, { points: 0 }) : r)),
      monthlyLucky: Object.assign({}, ml, { pointsMonth: cur, closed: kept }),
    });
    return { changed: true, state: next, closedMonths: [ml.pointsMonth] };
  }

  // ── the draw record ──────────────────────────────────────────────────
  /**
   * Build the permanent record for one month. Pure: seed + clock injected.
   *   { month, drawAt, players:[{id,name,points}], threshold, winnersWanted,
   *     prizes:[{id,name,qty,desc}], seed, nowMs, method:'auto'|'manual', source:'closed'|'live' }
   */
  function buildDrawResult(opts) {
    const o = opts || {};
    const month = String(o.month || '');
    const wanted = isWinnersCount(Number(o.winnersWanted)) ? Number(o.winnersWanted) : DEFAULT_WINNERS;
    const threshold = isThreshold(Number(o.threshold)) ? Number(o.threshold) : DEFAULT_THRESHOLD;
    const players = (Array.isArray(o.players) ? o.players : []).filter((p) => p && p.id);
    const seed = String(o.seed || '');
    const order = SD.shuffleWithSeed(players.map((p) => String(p.id)), seed);
    const winners = order.slice(0, Math.min(wanted, order.length));
    const names = {}, points = {};
    players.forEach((p) => { names[p.id] = String(p.name || p.id); points[p.id] = Number(p.points) || 0; });
    const prizes = normalizePrizes(o.prizes).map((p) => ({ id: p.id, name: p.name, qty: p.qty, desc: p.desc, place: p.place }));
    const at = Number(o.nowMs) || 0;
    return {
      v: RECORD_VERSION, kind: 'monthly', month, label: monthLabel(month),
      drawAt: Number.isFinite(Number(o.drawAt)) ? Number(o.drawAt) : null, drawnAt: at, createdAt: at,
      method: o.method === 'manual' ? 'manual' : 'auto', source: o.source === 'live' ? 'live' : 'closed',
      threshold, winnersWanted: wanted, seed, algorithm: ALGORITHM,
      eligible: players.map((p) => String(p.id)), names, points, order, winners, prizes,
      counts: { eligible: players.length, winners: winners.length },
      shortfall: winners.length < wanted,
    };
  }
  /** Recompute the shuffle from the recorded seed + eligible ids and compare with what was stored. */
  function verifyDrawResult(rec) {
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.eligible) || !Array.isArray(rec.order)) return false;
    if (rec.algorithm && rec.algorithm !== ALGORITHM) return false;
    const order = SD.shuffleWithSeed(rec.eligible, rec.seed);
    if (order.length !== rec.order.length || order.some((id, i) => id !== rec.order[i])) return false;
    const wanted = isWinnersCount(Number(rec.winnersWanted)) ? Number(rec.winnersWanted) : DEFAULT_WINNERS;
    const winners = order.slice(0, Math.min(wanted, order.length));
    const w = Array.isArray(rec.winners) ? rec.winners : [];
    return winners.length === w.length && winners.every((id, i) => id === w[i]);
  }
  /**
   * Winner rows with their prize: [{rank,id,name,points,prizeId,prize,prizeName,qty,desc}].
   * `prize` is the display label ("2 × Tube of shuttlecocks"); `prizeName` the bare name.
   */
  function awardsOf(rec, prizes) {
    const pz = Array.isArray(prizes) ? prizes : (rec && rec.prizes) || [];
    return ((rec && rec.winners) || []).map((id, i) => {
      const mine = pz.filter((x, xi) => x && placeOf(x, xi) === i + 1);
      const p = mine[0] || null;
      return {
        rank: i + 1, id, name: (rec.names && rec.names[id]) || id, points: rec.points ? (Number(rec.points[id]) || 0) : 0,
        // The first prize keeps the old single-prize fields; `prize` is every
        // label joined, so anything that only prints a string still reads right.
        prizeId: p ? p.id : null, prize: mine.map(prizeLabel).filter(Boolean).join(' + '), prizeName: p ? String(p.name || '') : '',
        qty: p && isPrizeQty(Number(p.qty)) ? Number(p.qty) : (p ? DEFAULT_PRIZE_QTY : 0), desc: p ? String(p.desc || '') : '',
        prizes: mine.map((x) => ({ id: x.id, name: String(x.name || ''), qty: isPrizeQty(Number(x.qty)) ? Number(x.qty) : DEFAULT_PRIZE_QTY,
          desc: String(x.desc || ''), label: prizeLabel(x) })),
      };
    });
  }

  // ── which months are in play ─────────────────────────────────────────
  /** The players a draw of `month` would use RIGHT NOW (pool / snapshot minus removals), or null when unknown. */
  function playersFor(state, month) {
    const s = state || {};
    const ml = normalize(s.monthlyLucky);
    const settings = settingsOf(s);
    const removed = ml.pool && ml.pool.month === month ? ml.pool.removed : [];
    if (ml.closed[month]) return { players: applyRemoved(eligibleFromSnapshot(ml.closed[month], settings.threshold), removed), source: 'closed' };
    if (month === ml.pointsMonth) {
      const base = ml.pool && ml.pool.month === month && ml.pool.pulledAt ? ml.pool.players : eligibleFromRoster(s.roster, settings.threshold);
      return { players: applyRemoved(base, removed), source: 'live' };
    }
    return null;
  }
  /** Months to list: closed months (drawn or not) + the live points month. Newest first. */
  function monthCandidates(state, offsetHours) {
    const ml = normalize(state && state.monthlyLucky);
    const months = new Set(Object.keys(ml.closed));
    if (isMonthKey(ml.pointsMonth)) months.add(ml.pointsMonth);
    return [...months].sort().reverse().map((m) => ({ month: m, drawAt: scheduledDrawAt(m, offsetHours), closed: !!ml.closed[m], live: m === ml.pointsMonth }));
  }

  // ── display shape (shared by the public page + admin list) ───────────
  function viewOf(cand, rec, nowMs, state, offsetHours) {
    const now = Number(nowMs) || 0;
    const settings = settingsOf(state);
    const month = rec ? rec.month : cand.month;
    const drawAt = rec && rec.drawAt != null ? rec.drawAt : scheduledDrawAt(month, offsetHours);
    const base = {
      month, label: monthLabel(month), drawAt, drawDate: drawDateFor(month), due: Number.isFinite(drawAt) && now >= drawAt,
      auto: settings.auto, threshold: rec ? rec.threshold : settings.threshold,
    };
    if (rec) {
      // Photos are not stored in the record: look them up by prize id in the current settings.
      const photoById = {};
      settings.prizes.forEach((p) => { photoById[p.id] = p.photo || null; });
      const prizes = (rec.prizes || []).map((p, pi) => ({ id: p.id, name: p.name, qty: isPrizeQty(Number(p.qty)) ? Number(p.qty) : DEFAULT_PRIZE_QTY, desc: String(p.desc || ''), place: placeOf(p, pi), photo: photoById[p.id] || null }));
      return Object.assign(base, {
        status: 'done', method: rec.method || 'auto', source: rec.source || 'closed', drawnAt: rec.drawnAt || null, seed: rec.seed || '',
        winnersWanted: rec.winnersWanted, shortfall: !!rec.shortfall, verified: verifyDrawResult(rec),
        counts: rec.counts || { eligible: (rec.eligible || []).length, winners: (rec.winners || []).length },
        lists: {
          eligible: (rec.eligible || []).map((id) => ({ id, name: (rec.names && rec.names[id]) || id, points: rec.points ? (Number(rec.points[id]) || 0) : 0 })).sort(byPointsThenName),
          winners: awardsOf(rec, prizes),
        },
        prizes,
      });
    }
    const pf = playersFor(state, month) || { players: [], source: 'live' };
    const ml = normalize(state && state.monthlyLucky);
    const pool = ml.pool && ml.pool.month === month ? ml.pool : null;
    return Object.assign(base, {
      status: 'pending', method: null, source: pf.source, drawnAt: null, seed: '', winnersWanted: settings.winners, shortfall: false, verified: null,
      closed: !!cand.closed, live: !!cand.live,
      counts: { eligible: pf.players.length, winners: 0 },
      lists: { eligible: pf.players, winners: [] },
      prizes: settings.prizes.map((p, pi) => ({ id: p.id, name: p.name, qty: p.qty, desc: p.desc, place: placeOf(p, pi), photo: p.photo || null })),
      pool: pool ? { pulledAt: pool.pulledAt, removed: pool.removed.slice(), stale: poolStaleIds(state, pool) } : null,
    });
  }
  /** The list: every stored result plus every candidate month, newest first. */
  function buildView(state, results, opts) {
    const o = opts || {};
    const res = results && typeof results === 'object' ? results : {};
    const cands = monthCandidates(state, o.offsetHours);
    const byMonth = new Map(cands.map((c) => [c.month, c]));
    const months = new Set(cands.map((c) => c.month));
    Object.keys(res).forEach((m) => { if (isMonthKey(m)) months.add(m); });
    const all = [...months].sort().reverse();
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 24;
    return {
      settings: settingsOf(state),
      pointsMonth: normalize(state && state.monthlyLucky).pointsMonth,
      months: all.slice(0, limit).map((m) => viewOf(byMonth.get(m) || { month: m, closed: true, live: false }, res[m] || null, o.nowMs, state, o.offsetHours)),
    };
  }
  /** What the PUBLIC page may see: winners + prizes; eligible names only once drawn; never points. */
  function publicMonthView(v) {
    if (!v || typeof v !== 'object') return v;
    const done = v.status === 'done';
    const lists = v.lists || {};
    return {
      month: v.month, label: v.label, drawAt: v.drawAt, drawDate: v.drawDate, due: v.due, auto: v.auto, threshold: v.threshold,
      status: v.status, method: v.method, drawnAt: v.drawnAt, seed: v.seed, winnersWanted: v.winnersWanted, shortfall: v.shortfall, verified: v.verified,
      counts: { eligible: (v.counts && v.counts.eligible) || 0, winners: (v.counts && v.counts.winners) || 0 },
      lists: {
        eligible: done ? (lists.eligible || []).map((r) => ({ id: r.id, name: r.name })) : [],
        winners: (lists.winners || []).map((w) => ({ rank: w.rank, id: w.id, name: w.name, prizeId: w.prizeId || null, prize: w.prize || '', prizeName: w.prizeName || '', qty: w.qty || 0, desc: w.desc || '',
          prizes: (w.prizes || []).map((x) => ({ id: x.id, name: x.name, qty: x.qty, desc: x.desc, label: x.label })) })),
      },
      prizes: (v.prizes || []).map((p, i) => ({ id: p.id, name: p.name, qty: isPrizeQty(Number(p.qty)) ? Number(p.qty) : DEFAULT_PRIZE_QTY, desc: String(p.desc || ''), place: placeOf(p, i), photo: p.photo || null })),
    };
  }

  // ── presentation strings ─────────────────────────────────────────────
  function drawTimeLabel() { const p = DRAW_TIME.split(':'); const h = Number(p[0]) || 0; return (h % 12 || 12) + ':' + String(Number(p[1]) || 0).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); }
  function howItWorksText(settings) {
    const s = settings || {};
    const t = isThreshold(Number(s.threshold)) ? Number(s.threshold) : DEFAULT_THRESHOLD;
    const n = isWinnersCount(Number(s.winners)) ? Number(s.winners) : DEFAULT_WINNERS;
    return 'Reach ' + t + ' points in a month to be in that month’s draw. '
      + n + ' winner' + (n === 1 ? '' : 's') + ' ' + (n === 1 ? 'is' : 'are') + ' picked at random'
      + (s.auto === false ? ' when an admin runs the draw' : ' at ' + drawTimeLabel() + ' on the 1st of the following month')
      + '. Points start again from zero every month.';
  }
  function statusLabel(view) {
    if (!view) return '';
    if (view.status === 'done') return 'Drawn';
    if (view.live) return 'This month';
    return view.auto && view.due ? 'Draw pending' : 'Waiting for admin';
  }

  return {
    DRAW_TIME, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD, DEFAULT_WINNERS, MIN_WINNERS, MAX_WINNERS, MAX_PRIZES, MAX_PRIZE_NAME, MAX_PRIZE_DESC, DEFAULT_PRIZE_QTY, MIN_PRIZE_QTY, MAX_PRIZE_QTY, MAX_PHOTO_BYTES, KEEP_CLOSED_MONTHS, ALGORITHM, RECORD_VERSION,
    isMonthKey, monthKeyOf, monthLabel, shiftMonthKey, nextMonthKey, prevMonthKey, yearOf, monthYearGrid, drawDateFor, scheduledDrawAt, monthOfInstant, isoOfInstant,
    isWinnersCount, isThreshold, isPrizeQty, isPhoto, newPrizeId, normalizePrizes, prizeLabel, settingsOf, normalize, liteOf,
    eligibleFromRoster, eligibleFromSnapshot, applyRemoved, buildPool, poolStaleIds,
    closeDue, closeIfDue,
    buildDrawResult, verifyDrawResult, awardsOf, placeOf, isPlace, playersFor, monthCandidates, viewOf, buildView, publicMonthView,
    drawTimeLabel, howItWorksText, statusLabel,
  };
});
