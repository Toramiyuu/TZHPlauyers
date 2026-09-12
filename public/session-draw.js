/*
 * session-draw.js — pure logic for the automatic per-session Lucky Draw.
 * Loaded in the browser via <script src> (window.SessionDraw) and required by
 * lib/session-draw.js + the Node tests. No dependencies, no DOM, no clock, no
 * randomness of its own: `nowMs` and the `seed` are ALWAYS injected so every
 * function is deterministic under test.
 *
 * Rules (fixed, not user-configurable except the winner count):
 *   - Every session on a draw day gets exactly one draw, at DRAW_TIME Malaysia
 *     time on the weekday DRAW_SCHEDULE maps it to (Mon -> Fri, Fri -> Tue,
 *     Sun -> Thu). That leaves the three days in between to pay.
 *   - Eligible = attended AND payment marked paid with paidAt strictly BEFORE
 *     the scheduled draw time. Lists nest: attended ⊇ paid ⊇ eligible ⊇ winners.
 *   - Winners = the first N of a Fisher–Yates shuffle of the eligible ids
 *     (sorted ascending first) driven by sfc32 seeded from a recorded 128-bit
 *     seed, so anyone can recompute the full order from the record (see
 *     verifyDrawResult). Fewer eligible than N -> all of them (shortfall).
 *     Zero eligible -> a record with no winners is still produced.
 *
 * Timestamps are epoch ms (UTC instants); display helpers render Asia/Kuala_Lumpur
 * (fixed UTC+8, no DST — `offsetHours` is injectable to match TZ_OFFSET_HOURS).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.SessionDraw = api;                                          // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── config (the ONLY place the schedule lives) ───────────────────────
  // Session weekday (0=Sun..6=Sat) -> weekday the draw happens on. Add a day here
  // to start drawing it; days not listed never draw.
  const DRAW_SCHEDULE = { 1: 5, 5: 2, 0: 4 };
  const DRAW_TIME = '09:00';          // wall-clock in Asia/Kuala_Lumpur
  const PAY_WINDOW_DAYS = 3;          // copy only: "pay within 3 days"
  // Sessions before this date are ignored (never drawn, never listed) so the
  // history starts with the feature instead of back-filling old nights. Server
  // side it can be moved with the DRAW_EPOCH env var (dev-server.js uses that
  // to seed demo nights); the browser never evaluates candidates itself.
  const DRAW_EPOCH = (typeof process !== 'undefined' && process.env && /^\d{4}-\d{2}-\d{2}$/.test(process.env.DRAW_EPOCH || ''))
    ? process.env.DRAW_EPOCH : '2026-09-09';
  const DEFAULT_WINNERS = 2, MIN_WINNERS = 1, MAX_WINNERS = 10;
  const ALGORITHM = 'sfc32-fisher-yates-v1';
  const RECORD_VERSION = 1;

  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DEFAULT_OFFSET_HOURS = 8;
  const TIME_ZONE = 'Asia/Kuala_Lumpur';
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── date helpers (self-contained so the browser needs nothing else) ──
  function isValidISO(s) { return typeof s === 'string' && ISO_RE.test(s); }
  function isoWeekday(iso) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return -1;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  }
  function addDaysISO(iso, n) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return String(iso);
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    dt.setUTCDate(dt.getUTCDate() + (Math.trunc(Number(n) || 0)));
    return dt.toISOString().slice(0, 10);
  }
  /** Epoch ms for `time` (HH:MM) Malaysia wall-clock on `iso`. */
  function mytInstant(iso, time, offsetHours) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return NaN;
    const parts = String(time == null ? '00:00' : time).split(':');
    const hh = Number(parts[0]) || 0, mm = Number(parts[1]) || 0;
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm) - off * 3600 * 1000;
  }

  // ── schedule ─────────────────────────────────────────────────────────
  function drawWeekdayFor(iso) {
    const wd = isoWeekday(iso);
    return Object.prototype.hasOwnProperty.call(DRAW_SCHEDULE, wd) ? DRAW_SCHEDULE[wd] : null;
  }
  function isDrawDay(iso) { return drawWeekdayFor(iso) != null; }
  /** ISO date the draw for a `iso` session happens on (first mapped weekday strictly after it), or null. */
  function drawDateFor(iso) {
    const target = drawWeekdayFor(iso);
    if (target == null) return null;
    const wd = isoWeekday(iso);
    let delta = ((target - wd) % 7 + 7) % 7;
    if (delta === 0) delta = 7;
    return addDaysISO(iso, delta);
  }
  /** Epoch ms of the scheduled draw for a `iso` session, or null when that weekday never draws. */
  function scheduledDrawAt(iso, offsetHours) {
    const d = drawDateFor(iso);
    return d ? mytInstant(d, DRAW_TIME, offsetHours) : null;
  }
  function isWinnersCount(n) { return Number.isInteger(n) && n >= MIN_WINNERS && n <= MAX_WINNERS; }
  function winnersOf(settings) {
    const n = settings && Number(settings.winners);
    return isWinnersCount(n) ? n : DEFAULT_WINNERS;
  }

  // ── lists ────────────────────────────────────────────────────────────
  function entriesOf(day) {
    const e = day && day.entries;
    return e && typeof e === 'object' ? e : {};
  }
  function nameOf(entry, fallback) { return (entry && entry.name) || fallback || ''; }
  /**
   * Who attended: attendance entries marked present (End of the day creates one per
   * line-up player). When the night has NO entries at all, fall back to the line-up
   * so the session still shows its attendees (nobody paid). Sorted by name.
   */
  function attendedFrom(day, lineup) {
    const entries = entriesOf(day);
    const ids = Object.keys(entries);
    let out;
    if (ids.length) {
      out = ids.filter((id) => entries[id] && entries[id].present).map((id) => ({ id, name: nameOf(entries[id], id) }));
    } else {
      const seen = new Set();
      out = [];
      for (const p of (Array.isArray(lineup) ? lineup : [])) {
        const id = p && p.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: p.name || id });
      }
    }
    return out.sort(byName);
  }
  function byName(a, b) { return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }); }
  /** Attendees whose entry is marked paid, with the paidAt stamp (null when the legacy checkbox set paid without a record). */
  function paidFrom(attended, day) {
    const entries = entriesOf(day);
    return (Array.isArray(attended) ? attended : [])
      .filter((a) => entries[a.id] && entries[a.id].paid)
      .map((a) => {
        const p = entries[a.id].payment;
        const at = p && p.paidAt != null ? Number(p.paidAt) : null;
        return { id: a.id, name: a.name, paidAt: Number.isFinite(at) ? at : null };
      });
  }
  /** Paid attendees whose paidAt is strictly before the draw time. */
  function eligibleFrom(paid, drawAt) {
    const cut = Number(drawAt);
    if (!Number.isFinite(cut)) return [];
    return (Array.isArray(paid) ? paid : []).filter((p) => p.paidAt != null && p.paidAt < cut);
  }

  // ── seeded randomness (deterministic, browser + Node) ────────────────
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  /** A 32-hex-char seed is used verbatim as the four sfc32 words; any other string is hashed first. */
  function prngFromSeed(seed) {
    const s = String(seed == null ? '' : seed);
    const words = /^[0-9a-fA-F]{32}$/.test(s)
      ? [0, 8, 16, 24].map((i) => parseInt(s.slice(i, i + 8), 16) >>> 0)
      : cyrb128(s);
    const rng = sfc32(words[0], words[1], words[2], words[3]);
    for (let i = 0; i < 15; i++) rng(); // warm up
    return rng;
  }
  /** Fisher–Yates over a SORTED copy of `ids`, driven by the seed. Same seed + same ids = same order. */
  function shuffleWithSeed(ids, seed) {
    const arr = (Array.isArray(ids) ? ids : []).map(String).sort();
    const rng = prngFromSeed(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ── the draw record ──────────────────────────────────────────────────
  /**
   * Build the permanent DrawResult for one session. Pure: seed + clock injected.
   *   { date, drawAt, day (attendance day record), lineup (session players),
   *     winnersWanted, seed, nowMs, method: 'auto' | 'manual' }
   */
  function buildDrawResult(opts) {
    const o = opts || {};
    const date = String(o.date || '');
    const drawAt = Number(o.drawAt);
    const wanted = isWinnersCount(Number(o.winnersWanted)) ? Number(o.winnersWanted) : DEFAULT_WINNERS;
    const attended = attendedFrom(o.day, o.lineup);
    const paid = paidFrom(attended, o.day);
    const eligible = eligibleFrom(paid, drawAt);
    const seed = String(o.seed || '');
    const order = shuffleWithSeed(eligible.map((e) => e.id), seed);
    const winners = order.slice(0, Math.min(wanted, order.length));
    const names = {};
    attended.forEach((a) => { names[a.id] = a.name; });
    const paidAt = {};
    paid.forEach((p) => { paidAt[p.id] = p.paidAt; });
    const at = Number(o.nowMs) || 0;
    return {
      v: RECORD_VERSION, date, weekday: isoWeekday(date), drawAt,
      drawnAt: at, createdAt: at, method: o.method === 'manual' ? 'manual' : 'auto',
      winnersWanted: wanted, seed, algorithm: ALGORITHM,
      attended: attended.map((a) => a.id), paid: paid.map((p) => p.id), eligible: eligible.map((e) => e.id),
      order, winners, names, paidAt,
      counts: { attended: attended.length, paid: paid.length, eligible: eligible.length, winners: winners.length },
      shortfall: winners.length < wanted,
    };
  }
  /** Recompute the shuffle from the recorded seed + eligible ids and compare with what was stored. */
  function verifyDrawResult(rec) {
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.eligible) || !Array.isArray(rec.order)) return false;
    if (rec.algorithm && rec.algorithm !== ALGORITHM) return false;
    const order = shuffleWithSeed(rec.eligible, rec.seed);
    if (order.length !== rec.order.length || order.some((id, i) => id !== rec.order[i])) return false;
    const wanted = isWinnersCount(Number(rec.winnersWanted)) ? Number(rec.winnersWanted) : DEFAULT_WINNERS;
    const winners = order.slice(0, Math.min(wanted, order.length));
    const w = Array.isArray(rec.winners) ? rec.winners : [];
    return winners.length === w.length && winners.every((id, i) => id === w[i]);
  }

  /**
   * Admin dry run ("Test draw"): the real rules and shuffle applied RIGHT NOW to a
   * session, never stored. drawAt = nowMs, so everyone marked paid so far is
   * eligible; when nobody has paid yet, every attendee is treated as paid so the
   * draw still shows winners (reported via `assumedPaid`). The record carries
   * test:true, which viewOf/statusLabel surface as "Test draw".
   */
  function testDrawResult(opts) {
    const o = opts || {};
    const now = Number(o.nowMs) || 0;
    const base = { date: o.date, drawAt: now, winnersWanted: o.winnersWanted, seed: o.seed, nowMs: now, method: 'auto' };
    let rec = buildDrawResult(Object.assign({}, base, { day: o.day, lineup: o.lineup }));
    let assumedPaid = false;
    if (!rec.counts.eligible && rec.counts.attended) {
      const entries = {};
      rec.attended.forEach((id) => { entries[id] = { playerId: id, name: rec.names[id] || id, present: true, paid: true, payment: { paidAt: now - 1 } }; });
      rec = buildDrawResult(Object.assign({}, base, { day: { entries }, lineup: [] }));
      assumedPaid = true;
    }
    rec.test = true;
    return { rec, assumedPaid };
  }

  // ── which sessions get a draw ────────────────────────────────────────
  function lineupOf(state, date) {
    const s = state || {};
    if (date === s.sessionDate) return Array.isArray(s.players) ? s.players : [];
    const snap = s.sessions && s.sessions[date];
    return snap && Array.isArray(snap.players) ? snap.players : [];
  }
  function dayOf(state, date) {
    const att = state && state.attendance;
    return att && typeof att === 'object' && att[date] ? att[date] : null;
  }
  function hasPresent(day) {
    const e = entriesOf(day);
    return Object.keys(e).some((id) => e[id] && e[id].present);
  }
  /** Stored draw time when the session was created (snapshot.drawAt / live sessionDrawAt), else the table. */
  function drawAtFor(state, date, offsetHours) {
    const s = state || {};
    if (date === s.sessionDate && (typeof s.sessionDrawAt === 'number' || s.sessionDrawAt === null) && s.sessionDrawAt !== undefined) {
      return s.sessionDrawAt;
    }
    const snap = s.sessions && s.sessions[date];
    if (snap && (typeof snap.drawAt === 'number' || snap.drawAt === null) && snap.drawAt !== undefined) return snap.drawAt;
    return scheduledDrawAt(date, offsetHours);
  }
  /**
   * Dates that count as sessions with a draw: a draw-day date on/after DRAW_EPOCH
   * that has >= 1 player in the line-up (live day or snapshot) or >= 1 present
   * attendance entry. Newest first.
   */
  function sessionCandidates(state, offsetHours) {
    const s = state || {};
    const dates = new Set();
    if (isValidISO(s.sessionDate) && Array.isArray(s.players) && s.players.length) dates.add(s.sessionDate);
    for (const d of Object.keys(s.sessions || {})) {
      const snap = s.sessions[d];
      if (snap && Array.isArray(snap.players) && snap.players.length) dates.add(d);
    }
    for (const d of Object.keys(s.attendance || {})) if (hasPresent(s.attendance[d])) dates.add(d);
    return [...dates]
      .filter((d) => isValidISO(d) && d >= DRAW_EPOCH && isDrawDay(d))
      .sort().reverse()
      .map((d) => ({ date: d, drawAt: drawAtFor(s, d, offsetHours), lineup: lineupOf(s, d), day: dayOf(s, d) }));
  }

  // ── display shape (shared by the public page + admin list) ───────────
  function rowsFromIds(ids, names) { return (ids || []).map((id) => ({ id, name: (names && names[id]) || id })); }
  /**
   * One session as the page shows it. `rec` = the stored DrawResult or null.
   * Pending sessions compute their lists live ("eligible so far"); done ones are
   * frozen to the record. `late` marks a paid row that missed the cutoff.
   */
  function viewOf(cand, rec, nowMs, settings) {
    const now = Number(nowMs) || 0;
    const date = rec ? rec.date : cand.date;
    const drawAt = rec ? rec.drawAt : cand.drawAt;
    const base = {
      date, weekday: isoWeekday(date), weekdayName: WEEKDAY_NAMES[isoWeekday(date)] || '',
      drawAt, drawDate: drawDateFor(date), due: Number.isFinite(drawAt) && now >= drawAt,
    };
    if (rec) {
      const paidRows = rowsFromIds(rec.paid, rec.names).map((r) => {
        const at = rec.paidAt && rec.paidAt[r.id] != null ? rec.paidAt[r.id] : null;
        return { id: r.id, name: r.name, paidAt: at, late: !(at != null && at < rec.drawAt) };
      });
      return Object.assign(base, {
        status: 'done', test: !!rec.test, method: rec.method || 'auto', drawnAt: rec.drawnAt || null, seed: rec.seed || '',
        winnersWanted: rec.winnersWanted, shortfall: !!rec.shortfall, verified: verifyDrawResult(rec),
        counts: rec.counts || { attended: (rec.attended || []).length, paid: (rec.paid || []).length, eligible: (rec.eligible || []).length, winners: (rec.winners || []).length },
        lists: {
          attended: rowsFromIds(rec.attended, rec.names),
          paid: paidRows,
          eligible: rowsFromIds(rec.eligible, rec.names).map((r) => ({ id: r.id, name: r.name, paidAt: rec.paidAt ? rec.paidAt[r.id] : null })),
          winners: rowsFromIds(rec.winners, rec.names),
        },
      });
    }
    const attended = attendedFrom(cand.day, cand.lineup);
    const paid = paidFrom(attended, cand.day);
    const eligible = eligibleFrom(paid, drawAt);
    const eligibleIds = new Set(eligible.map((e) => e.id));
    return Object.assign(base, {
      status: 'pending', method: null, drawnAt: null, seed: '', winnersWanted: winnersOf(settings), shortfall: false, verified: null,
      counts: { attended: attended.length, paid: paid.length, eligible: eligible.length, winners: 0 },
      lists: {
        attended,
        paid: paid.map((p) => ({ id: p.id, name: p.name, paidAt: p.paidAt, late: !eligibleIds.has(p.id) })),
        eligible,
        winners: [],
      },
    });
  }
  /**
   * The page list: every stored result plus every pending candidate, newest first.
   * opts = { nowMs, settings, limit (default 40), before (ISO, exclusive), offsetHours }.
   */
  function buildView(state, results, opts) {
    const o = opts || {};
    const res = results && typeof results === 'object' ? results : {};
    const cands = sessionCandidates(state, o.offsetHours);
    const byDate = new Map(cands.map((c) => [c.date, c]));
    const dates = new Set(cands.map((c) => c.date));
    Object.keys(res).forEach((d) => { if (isValidISO(d)) dates.add(d); });
    let all = [...dates].sort().reverse();
    if (isValidISO(o.before)) all = all.filter((d) => d < o.before);
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 40;
    const page = all.slice(0, limit);
    return {
      sessions: page.map((d) => viewOf(byDate.get(d) || { date: d, drawAt: scheduledDrawAt(d, o.offsetHours), lineup: [], day: null }, res[d] || null, o.nowMs, o.settings)),
      hasMore: all.length > limit,
      nextBefore: all.length > limit ? page[page.length - 1] : null,
    };
  }

  /**
   * What the PUBLIC Lucky Draw page may see: no attendance or payment detail.
   * Winners always; the eligible NAMES only once drawn (the replay video spins
   * over them); never who attended, who paid, or when anyone paid.
   */
  function publicSessionView(v) {
    if (!v || typeof v !== 'object') return v;
    const done = v.status === 'done';
    const lists = v.lists || {};
    const c = v.counts || {};
    const names = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, name: r.name }));
    return {
      date: v.date, weekday: v.weekday, weekdayName: v.weekdayName, drawAt: v.drawAt, drawDate: v.drawDate, due: v.due,
      status: v.status, test: !!v.test, method: v.method, drawnAt: v.drawnAt, seed: v.seed, winnersWanted: v.winnersWanted, shortfall: v.shortfall, verified: v.verified,
      counts: { eligible: c.eligible || 0, winners: c.winners || 0 },
      lists: { eligible: done ? names(lists.eligible) : [], winners: names(lists.winners) },
    };
  }

  // ── presentation strings ─────────────────────────────────────────────
  function mytParts(msValue) {
    const d = new Date((Number(msValue) || 0) + DEFAULT_OFFSET_HOURS * 3600 * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
  }
  function fmtTime12(h, mi) { return (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); }
  /** "Fri 12 Sep · 9:00 AM" (Malaysia time). */
  function fmtDrawTime(msValue) {
    if (msValue == null || !Number.isFinite(Number(msValue))) return '';
    const t = mytParts(msValue);
    return WEEKDAY_SHORT[t.wd] + ' ' + t.day + ' ' + MONTHS_SHORT[t.mo] + ' · ' + fmtTime12(t.h, t.mi);
  }
  /** "9:42 AM" (Malaysia time). */
  function fmtMYT(msValue) {
    if (!msValue) return '';
    const t = mytParts(msValue);
    return fmtTime12(t.h, t.mi);
  }
  /** "Monday 7 September 2026" for an ISO date. */
  function fmtSessionDate(iso) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return String(iso || '');
    const wd = isoWeekday(iso);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return WEEKDAY_NAMES[wd] + ' ' + (+m[3]) + ' ' + months[+m[2] - 1] + ' ' + m[1];
  }
  function statusLabel(view) {
    if (!view) return '';
    if (view.test) return 'Test draw';
    if (view.status === 'done') return 'Drawn';
    return view.due ? 'Draw pending' : 'Pending';
  }
  function drawDayLabel() {
    // Monday-first week order so the copy reads "Mon → Fri, Fri → Tue, Sun → Thu".
    return [1, 2, 3, 4, 5, 6, 0].filter((k) => DRAW_SCHEDULE[k] != null)
      .map((k) => WEEKDAY_SHORT[k] + ' → ' + WEEKDAY_SHORT[DRAW_SCHEDULE[k]]).join(', ');
  }
  function drawTimeLabel() {
    const parts = DRAW_TIME.split(':');
    return fmtTime12(Number(parts[0]) || 0, Number(parts[1]) || 0);
  }
  function howItWorksText(winners) {
    const n = isWinnersCount(Number(winners)) ? Number(winners) : DEFAULT_WINNERS;
    return 'Play a session and pay within ' + PAY_WINDOW_DAYS + ' days to be in the draw. '
      + n + ' winner' + (n === 1 ? '' : 's') + ' ' + (n === 1 ? 'is' : 'are') + ' picked at random at ' + drawTimeLabel()
      + ' (' + drawDayLabel() + '). Payments marked after the draw time do not count.';
  }
  function countsLine(c) {
    const x = c || {};
    return (x.attended || 0) + ' attended · ' + (x.paid || 0) + ' paid · ' + (x.eligible || 0) + ' eligible · ' + (x.winners || 0) + ' winner' + ((x.winners || 0) === 1 ? '' : 's');
  }

  return {
    DRAW_SCHEDULE, DRAW_TIME, PAY_WINDOW_DAYS, DRAW_EPOCH, DEFAULT_WINNERS, MIN_WINNERS, MAX_WINNERS, ALGORITHM, RECORD_VERSION, TIME_ZONE,
    WEEKDAY_NAMES, WEEKDAY_SHORT,
    isValidISO, isoWeekday, addDaysISO, mytInstant,
    drawWeekdayFor, isDrawDay, drawDateFor, scheduledDrawAt, isWinnersCount, winnersOf,
    attendedFrom, paidFrom, eligibleFrom,
    prngFromSeed, shuffleWithSeed, buildDrawResult, verifyDrawResult, testDrawResult,
    lineupOf, dayOf, drawAtFor, sessionCandidates, viewOf, buildView, publicSessionView,
    fmtDrawTime, fmtMYT, fmtSessionDate, statusLabel, drawDayLabel, drawTimeLabel, howItWorksText, countsLine,
  };
});
