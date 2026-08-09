/*
 * weekly-draw.js — pure logic for the Weekly Lucky Draw.
 * Loaded in the browser via <script src> (window.WeeklyDraw) and required by Node tests.
 * No dependencies, no build step. Pure — the clock (nowMs) and randomness (rng) are
 * ALWAYS injected so every function is deterministic under test.
 *
 * Model: each session day (Mon/Fri/Sun) has its own attendance record. A player is
 * ELIGIBLE for that day's draw when Present AND Paid. Entries for a session close at
 * the next configured cutoff (default Wed 17:00 MYT) and the winner is drawn at the
 * next configured draw time (default Wed 20:00 MYT). Each session day draws its own
 * single winner and keeps its own history.
 *
 * Timezone: instants are computed in Malaysia time (UTC+8, no DST) via an injected
 * offsetHours (default 8) so this matches the server's TZ_OFFSET_HOURS.
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

  const DEFAULT_SETTINGS = {
    enabled: true,
    cutoff: { weekday: 3, time: '17:00' }, // Wed 17:00 MYT
    draw: { weekday: 3, time: '20:00' },   // Wed 20:00 MYT
  };

  function settingsOf(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const cutoff = s.cutoff && typeof s.cutoff === 'object' ? s.cutoff : DEFAULT_SETTINGS.cutoff;
    const draw = s.draw && typeof s.draw === 'object' ? s.draw : DEFAULT_SETTINGS.draw;
    return {
      enabled: s.enabled !== false,
      cutoff: { weekday: cutoff.weekday == null ? 3 : Number(cutoff.weekday), time: cutoff.time || '17:00' },
      draw: { weekday: draw.weekday == null ? 3 : Number(draw.weekday), time: draw.time || '20:00' },
    };
  }

  /** ms instant when entries for a `date` session close. */
  function closesAt(date, settings, offsetHours) {
    const s = settingsOf(settings);
    return mytInstant(onOrAfterWeekday(date, s.cutoff.weekday), s.cutoff.time, offsetHours);
  }
  /** ms instant when a `date` session is auto-drawn. */
  function drawsAt(date, settings, offsetHours) {
    const s = settingsOf(settings);
    return mytInstant(onOrAfterWeekday(date, s.draw.weekday), s.draw.time, offsetHours);
  }
  /** True once the auto-draw time for `date` has arrived. */
  function isDrawable(date, settings, nowMs, offsetHours) {
    return Number(nowMs) >= drawsAt(date, settings, offsetHours);
  }
  /** True while entries can still be edited (before the cutoff). */
  function entriesOpen(date, settings, nowMs, offsetHours) {
    return Number(nowMs) < closesAt(date, settings, offsetHours);
  }

  /**
   * Live status for the schedule panel. `drawn` = a winner already exists.
   * Returns { code, label, closesAt, drawsAt }. Countdown text is formatted by
   * the caller from the returned instants.
   */
  function liveStatus(date, settings, nowMs, drawn, offsetHours) {
    const c = closesAt(date, settings, offsetHours);
    const d = drawsAt(date, settings, offsetHours);
    const now = Number(nowMs);
    let code, label;
    if (drawn) { code = 'drawn'; label = 'Draw completed'; }
    else if (now >= d) { code = 'due'; label = 'Automatic draw pending'; }
    else if (now >= c) { code = 'closed'; label = 'Entries closed — drawing tonight'; }
    else { code = 'open'; label = 'Entries open'; }
    return { code, label, closesAt: c, drawsAt: d };
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

  /**
   * Build a full draw-result record for `date`. Pure: rng + nowMs injected.
   * `by` = 'cron' | 'admin'. Returns null (with a marker) when there are no
   * eligible entries so the caller can record a "failed"/empty draw.
   */
  function buildDrawResult(date, weekday, entries, rng, by, nowMs) {
    const eligible = eligibleFromAttendance(entries);
    const winner = pickWinner(eligible, rng);
    return {
      date,
      weekday,
      eligible,
      eligibleCount: eligible.length,
      winner: winner || null,
      drawnAt: Number(nowMs) || 0,
      drawnBy: by || 'admin',
      ok: !!winner,
    };
  }

  return {
    DEFAULT_SETTINGS, settingsOf,
    isoWeekday, addDaysISO, onOrAfterWeekday, mytInstant,
    closesAt, drawsAt, isDrawable, entriesOpen, liveStatus,
    candidateList, ineligibleReason, eligibleFromAttendance, pickWinner, buildDrawResult,
  };
});
