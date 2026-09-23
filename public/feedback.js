/*
 * feedback.js — pure logic for per-player session feedback.
 * Loaded in the browser via <script src> (window.Feedback) and required by lib/feedback.js
 * and the Node tests. No dependencies, no DOM, no clock: `nowMs` is ALWAYS injected so every
 * function is deterministic under test.
 *
 * Model: ONE record per player per NIGHT, in its own top-level map —
 * state.feedback[nightISO][playerId]. Deliberately NOT nested in the attendance entry
 * like `payment` is: doSetAttendance (lib/weekly.js) rebuilds each entry field by field
 * and carries only `payment` across, so anything else stored there is dropped the next
 * time an admin ticks a checkbox.
 *
 *   record = { playerId, name, good:[optionId], bad:[optionId], goodNote, badNote,
 *              at, updatedAt, awarded }
 *
 * Both sides are multi-select and either side may be empty — what is refused is a wholly
 * empty submission (no options, no notes). `awarded` is the points latch: the +N is paid
 * once, on the first submission for that player and night, so editing never pays twice.
 *
 * The option ids are the stable part and the labels are free to be reworded; an id that
 * is not in the catalogue is dropped rather than stored, so a renamed option can never
 * leave unreadable rows behind in the admin tab.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.Feedback = api;                                             // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── the option catalogue ─────────────────────────────────────────────
  // Four a side, mirrored: each complaint has the compliment that answers it, so a night
  // reads as a pair of tallies rather than two unrelated lists.
  const GOOD_OPTIONS = [
    { id: 'level',             label: 'Games were at a good level' },
    { id: 'quick-rotation',    label: 'Didn’t wait long between games' },
    { id: 'balanced-partners', label: 'Well-balanced partners' },
    { id: 'variety',           label: 'Good mix of opponents' },
  ];
  const BAD_OPTIONS = [
    { id: 'same-partners',  label: 'Kept partnering the same people' },
    { id: 'same-opponents', label: 'Kept playing the same opponents' },
    { id: 'no-challenge',   label: 'Didn’t get to play stronger opponents' },
    { id: 'long-wait',      label: 'Waited too long between games' },
  ];

  const GOOD_IDS = GOOD_OPTIONS.map((o) => o.id);
  const BAD_IDS = BAD_OPTIONS.map((o) => o.id);
  const LABELS = {};
  for (const o of GOOD_OPTIONS.concat(BAD_OPTIONS)) LABELS[o.id] = o.label;

  const MAX_NOTE = 500;          // a paragraph, not an essay — keeps the blob small
  const DEFAULT_POINTS = 5;
  const MAX_POINTS_PER = 50;     // guard rail on the Settings number input
  const RETENTION_DAYS = 100;    // matches lib/weekly.js ATTENDANCE_RETENTION_DAYS
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  // The admin tab opens on a cross-night "what came in lately" overview rather
  // than on one night: members rate ANY night they played, so a reply that
  // landed this morning can be about a night three weeks back and would never
  // be seen from a per-night calendar. Window is measured on the SUBMISSION
  // time, not the night.
  const RECENT_DAYS = 2;
  const RECENT_FALLBACK = 10;    // quiet fortnight: show the latest N instead of nothing
  const DAY_MS = 86400000;

  const isValidISO = (s) => typeof s === 'string' && ISO_RE.test(s);
  const isGoodId = (id) => GOOD_IDS.includes(id);
  const isBadId = (id) => BAD_IDS.includes(id);
  const labelOf = (id) => LABELS[id] || '';

  function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** Known ids only, deduped, in catalogue order. Never mutates the input. Pure. */
  function cleanOptions(list, allowed) {
    if (!Array.isArray(list)) return [];
    const wanted = new Set(list.filter((id) => typeof id === 'string'));
    return allowed.filter((id) => wanted.has(id));
  }

  /** Collapse whitespace and cap at MAX_NOTE. Pure. */
  function cleanNote(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  }

  // ── settings ─────────────────────────────────────────────────────────
  /** Whole numbers 0..MAX_POINTS_PER. 0 is legal: feedback with no points attached. */
  function isPointsValue(n) {
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= MAX_POINTS_PER;
  }

  /** { enabled, points } from any (possibly junk or absent) blob. Pure. */
  function settingsOf(state) {
    const fs = state && state.feedbackSettings && typeof state.feedbackSettings === 'object'
      ? state.feedbackSettings : {};
    return {
      enabled: fs.enabled === undefined ? true : !!fs.enabled,
      points: isPointsValue(Number(fs.points)) ? Number(fs.points) : DEFAULT_POINTS,
    };
  }

  // ── submissions ──────────────────────────────────────────────────────
  /**
   * Build one sanitized record from a request body. Self-builds every field — the body is
   * NEVER spread — so this can only ever produce the shape above, whatever arrives.
   * `prev` (an existing record, or null) carries `at` and `awarded` forward so an edit
   * keeps its original timestamp and never re-triggers the award.
   * Returns { ok, record } or { ok:false, error }. Pure.
   */
  function buildSubmission(body, ctx, prev) {
    const b = body && typeof body === 'object' ? body : {};
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const good = cleanOptions(b.good, GOOD_IDS);
    const bad = cleanOptions(b.bad, BAD_IDS);
    const goodNote = cleanNote(b.goodNote);
    const badNote = cleanNote(b.badNote);
    if (!good.length && !bad.length && !goodNote && !badNote) {
      return { ok: false, error: 'Pick at least one option, or write a note.' };
    }
    const at = Number(c.nowMs) || 0;
    const p = prev && typeof prev === 'object' ? prev : null;
    return {
      ok: true,
      record: {
        playerId: String(c.playerId == null ? '' : c.playerId),
        name: String(c.name == null ? '' : c.name).slice(0, 80),
        good, bad, goodNote, badNote,
        at: (p && Number(p.at)) || at,
        updatedAt: at,
        awarded: !!(p && p.awarded),
        // What was ACTUALLY credited, carried forward untouched by an edit. The live
        // setting is no use for the read-back: change it from 5 to 3 next month and
        // every old reply would start claiming it earned 3.
        awardedPoints: (p && Math.max(0, Math.trunc(Number(p.awardedPoints)) || 0)) || 0,
      },
    };
  }

  /** One player's record for a night, or null. Pure. */
  function recordFor(state, night, playerId) {
    const all = state && isPlainMap(state.feedback) ? state.feedback : {};
    const day = isPlainMap(all[night]) ? all[night] : null;
    const rec = day && isPlainMap(day[playerId]) ? day[playerId] : null;
    return rec || null;
  }

  /** True when the record says something. Used to skip empty/junk rows on read. Pure. */
  function hasContent(rec) {
    if (!isPlainMap(rec)) return false;
    return !!((Array.isArray(rec.good) && rec.good.length) || (Array.isArray(rec.bad) && rec.bad.length)
      || rec.goodNote || rec.badNote);
  }

  /**
   * A night's rows plus the per-option tallies, for the admin tab.
   * `names` ({ playerId: name }) lets live roster names win over the name stored on the
   * record, the same way the Payments ledger prefers the roster spelling.
   * Newest submission first. Pure.
   */
  function summarizeNight(day, names) {
    const src = isPlainMap(day) ? day : {};
    const nameMap = isPlainMap(names) ? names : {};
    const good = {}, bad = {};
    for (const id of GOOD_IDS) good[id] = 0;
    for (const id of BAD_IDS) bad[id] = 0;
    const rows = [];
    for (const pid of Object.keys(src)) {
      const rec = src[pid];
      if (!hasContent(rec)) continue;
      const g = cleanOptions(rec.good, GOOD_IDS);
      const b = cleanOptions(rec.bad, BAD_IDS);
      for (const id of g) good[id]++;
      for (const id of b) bad[id]++;
      rows.push({
        playerId: pid,
        name: nameMap[pid] || rec.name || pid,
        good: g, bad: b,
        goodNote: cleanNote(rec.goodNote),
        badNote: cleanNote(rec.badNote),
        at: Number(rec.at) || 0,
        updatedAt: Number(rec.updatedAt) || Number(rec.at) || 0,
        edited: (Number(rec.updatedAt) || 0) > (Number(rec.at) || 0),
      });
    }
    rows.sort((a, b2) => (b2.updatedAt - a.updatedAt) || String(a.name).localeCompare(String(b2.name), undefined, { sensitivity: 'base' }));
    const goodTotal = rows.reduce((n, r) => n + r.good.length, 0);
    const badTotal = rows.reduce((n, r) => n + r.bad.length, 0);
    return { count: rows.length, good, bad, goodTotal, badTotal, rows };
  }

  /**
   * Every real row in the whole store, flattened and stamped with the night it
   * is about, newest SUBMISSION first. Pure. Used to build the overview.
   */
  function allSubmissions(state, names) {
    const all = state && isPlainMap(state.feedback) ? state.feedback : {};
    const nameMap = isPlainMap(names) ? names : {};
    const rows = [];
    for (const night of Object.keys(all)) {
      if (!isValidISO(night)) continue;
      const day = isPlainMap(all[night]) ? all[night] : {};
      for (const pid of Object.keys(day)) {
        const rec = day[pid];
        if (!hasContent(rec)) continue;
        const at = Number(rec.at) || 0;
        const updatedAt = Number(rec.updatedAt) || at;
        rows.push({
          night,
          playerId: pid,
          name: nameMap[pid] || rec.name || pid,
          good: cleanOptions(rec.good, GOOD_IDS),
          bad: cleanOptions(rec.bad, BAD_IDS),
          goodNote: cleanNote(rec.goodNote),
          badNote: cleanNote(rec.badNote),
          at,
          updatedAt,
          edited: updatedAt > at,
        });
      }
    }
    rows.sort((a, b) => (b.updatedAt - a.updatedAt)
      || b.night.localeCompare(a.night)
      || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    return rows;
  }

  /**
   * The overview: every reply SUBMITTED in the last `days` days, whatever night
   * it is about, grouped under its night (newest night first) so the admin can
   * jump straight to that date. When nothing landed in the window the latest
   * `limit` replies are returned instead with `fallback:true` — an empty tab is
   * worse than a slightly older one. Pure; `nowMs` is injected.
   */
  function recentSubmissions(state, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const nowMs = Number(c.nowMs) || 0;
    const days = Number.isFinite(Number(c.days)) ? Number(c.days) : RECENT_DAYS;
    const limit = Math.max(1, Math.trunc(Number(c.limit)) || RECENT_FALLBACK);
    const rows = allSubmissions(state, c.names);
    const since = nowMs - days * DAY_MS;
    const inWindow = rows.filter((r) => r.updatedAt >= since);
    const fallback = !inWindow.length && rows.length > 0;
    const use = fallback ? rows.slice(0, limit) : inWindow;
    const byNight = new Map();
    for (const r of use) {
      if (!byNight.has(r.night)) byNight.set(r.night, []);
      byNight.get(r.night).push(r);
    }
    const nights = Array.from(byNight.keys())
      .sort((a, b) => b.localeCompare(a))
      .map((night) => ({ night, rows: byNight.get(night) }));
    return { days, since, fallback, count: use.length, total: rows.length, rows: use, nights };
  }

  /** Every night that has at least one real row, newest first. Pure. */
  function nightsWithFeedback(state) {
    const all = state && isPlainMap(state.feedback) ? state.feedback : {};
    return Object.keys(all)
      .filter((d) => isValidISO(d) && Object.keys(isPlainMap(all[d]) ? all[d] : {}).some((pid) => hasContent(all[d][pid])))
      .sort((a, b) => b.localeCompare(a));
  }

  /** Count of rows for one night. Pure. */
  function countFor(state, night) {
    const all = state && isPlainMap(state.feedback) ? state.feedback : {};
    const day = isPlainMap(all[night]) ? all[night] : {};
    return Object.keys(day).filter((pid) => hasContent(day[pid])).length;
  }

  /**
   * Drop nights past the retention window, in place, mirroring pruneWeeklyState.
   * `addDays` is injected (public/weekly-draw.js owns the ISO maths) so this module keeps
   * no date arithmetic of its own. Returns state.
   */
  function pruneFeedback(state, today, addDays) {
    if (!state || !isPlainMap(state.feedback)) return state;
    if (!isValidISO(today) || typeof addDays !== 'function') return state;
    const cutoff = addDays(today, -RETENTION_DAYS);
    for (const d of Object.keys(state.feedback)) {
      if (!isValidISO(d) || d >= cutoff) continue;
      delete state.feedback[d];
    }
    return state;
  }

  return {
    GOOD_OPTIONS, BAD_OPTIONS, GOOD_IDS, BAD_IDS, LABELS,
    MAX_NOTE, DEFAULT_POINTS, MAX_POINTS_PER, RETENTION_DAYS,
    RECENT_DAYS, RECENT_FALLBACK,
    isValidISO, isGoodId, isBadId, labelOf, isPointsValue,
    cleanOptions, cleanNote, settingsOf,
    buildSubmission, recordFor, hasContent,
    summarizeNight, nightsWithFeedback, countFor, pruneFeedback,
    allSubmissions, recentSubmissions,
  };
});
