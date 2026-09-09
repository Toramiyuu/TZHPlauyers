/*
 * weekly-draw.js — small pure helpers shared by the attendance records + Monthly
 * eligibility: ISO date maths in Malaysia time, the per-night candidate list, and
 * present&&paid eligibility. (The Weekly Lucky Draw schedule/draw functions that
 * used to live here were retired in 2026-09 — see public/session-draw.js.)
 * Loaded in the browser via <script src> (window.WeeklyDraw) and required by Node.
 * No dependencies, no build step, no clock: everything is injected.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.WeeklyDraw = api;                                           // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DEFAULT_OFFSET_HOURS = 8;

  // ── tiny self-contained date helpers (browser can't require state.js) ──
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
  // First date on-or-after `fromISO` whose weekday === target (0=Sun..6=Sat).
  function onOrAfterWeekday(fromISO, target) {
    const wd = isoWeekday(fromISO);
    if (wd < 0) return fromISO;
    const delta = (((Number(target) || 0) - wd) % 7 + 7) % 7;
    return addDaysISO(fromISO, delta);
  }
  // Epoch ms for `time` (HH:MM) MYT wall-clock on `iso`.
  function mytInstant(iso, time, offsetHours) {
    const m = ISO_RE.exec(String(iso));
    if (!m) return NaN;
    const parts = String(time == null ? '00:00' : time).split(':');
    const hh = Number(parts[0]) || 0, mm = Number(parts[1]) || 0;
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm) - off * 3600 * 1000;
  }

  /**
   * Build the candidate player list for a session day, deduped by playerId.
   * Session players (who actually showed) come first, then that weekday's regulars,
   * then any extra ids the caller resolved from signups. Names resolve against the
   * roster when not provided. Pure — never mutates inputs.
   */
  function candidateList(regulars, weekday, sessionPlayers, roster, extraIds) {
    const byId = new Map((Array.isArray(roster) ? roster : []).map((r) => [r.id, r]));
    const out = [];
    const seen = new Set();
    const add = (id, name, source) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const r = byId.get(id);
      out.push({ playerId: id, name: name || (r && r.name) || id, source });
    };
    (Array.isArray(sessionPlayers) ? sessionPlayers : []).forEach((p) => p && add(p.id, p.name, 'session'));
    const map = regulars && typeof regulars === 'object' ? regulars : {};
    const regs = Array.isArray(map[weekday]) ? map[weekday] : (Array.isArray(map[String(weekday)]) ? map[String(weekday)] : []);
    regs.forEach((id) => add(id, null, 'regular'));
    (Array.isArray(extraIds) ? extraIds : []).forEach((id) => add(id, null, 'signup'));
    return out;
  }

  /** Human reason a candidate is not eligible (present+paid). '' when eligible. */
  function ineligibleReason(entry) {
    if (!entry) return 'No attendance record';
    if (!entry.present) return 'Absent';
    if (!entry.paid) return 'Unpaid';
    return '';
  }

  /**
   * Eligible players (present && paid) from a day's attendance `entries`
   * (object keyed by playerId, or an array). Returns [{playerId, name}].
   */
  function eligibleFromAttendance(entries) {
    const list = Array.isArray(entries) ? entries : Object.values(entries || {});
    return list
      .filter((e) => e && e.present && e.paid)
      .map((e) => ({ playerId: e.playerId, name: e.name }));
  }

  /** Pick one winner from an eligible list using injected rng (default Math.random). */
  function pickWinner(eligible, rng) {
    const list = Array.isArray(eligible) ? eligible : [];
    if (!list.length) return null;
    const r = typeof rng === 'function' ? rng : Math.random;
    const i = Math.min(list.length - 1, Math.max(0, Math.floor(r() * list.length)));
    return list[i];
  }

  return {
    isoWeekday, addDaysISO, onOrAfterWeekday, mytInstant,
    candidateList, ineligibleReason, eligibleFromAttendance, pickWinner,
  };
});
