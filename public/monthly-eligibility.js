/*
 * monthly-eligibility.js — pure logic for auto-computed Monthly Lucky Draw eligibility.
 * Loaded in the browser via <script src> (window.MonthlyEligibility) and required by Node tests.
 * No dependencies, no build step. Pure — todayISO is injected; never reads the clock.
 *
 * Temporary rule (designed to be tunable later): a player is enrolled in the Monthly
 * Lucky Draw only when they attended AND paid EVERY required session of their regular
 * session weekday(s) in that month. "Required sessions" = the occurrences of the
 * player's regular weekday(s) in the month that have already happened (date <= today),
 * so a mid-month view shows eligibility "so far" and it settles as the month ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.MonthlyEligibility = api;                                   // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MONTH_RE = /^(\d{4})-(\d{2})$/;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function daysInMonth(y, mo /*1-12*/) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
  function weekdayOf(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

  /** Weekdays (0-6) a player is a regular for, from state.regulars (weekday->[ids]). */
  function playerRegularWeekdays(regulars, playerId) {
    const map = regulars && typeof regulars === 'object' ? regulars : {};
    const out = [];
    for (const key of Object.keys(map)) {
      const wd = Number(key);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
      if (Array.isArray(map[key]) && map[key].indexOf(playerId) !== -1) out.push(wd);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * All dates in `month` (YYYY-MM) whose weekday is in `weekdays`, that are on or
   * before `todayISO`. Sorted ascending ISO strings.
   */
  function requiredDatesForMonth(month, weekdays, todayISO) {
    const m = MONTH_RE.exec(String(month || ''));
    if (!m) return [];
    const y = +m[1], mo = +m[2];
    const wdSet = new Set((Array.isArray(weekdays) ? weekdays : []).map(Number));
    const today = String(todayISO || '');
    const out = [];
    const n = daysInMonth(y, mo);
    for (let d = 1; d <= n; d++) {
      if (!wdSet.has(weekdayOf(y, mo, d))) continue;
      const iso = y + '-' + pad2(mo) + '-' + pad2(d);
      if (today && iso > today) continue;   // future session: not "missed" yet
      out.push(iso);
    }
    return out;
  }

  /** Attendance entry for a player on a date, from state.attendance. null if none. */
  function entryFor(attendanceByDate, date, playerId) {
    const day = attendanceByDate && attendanceByDate[date];
    if (!day || !day.entries) return null;
    return day.entries[playerId] || null;
  }

  /**
   * Full eligibility record for one player. Pure.
   * Returns { playerId, name, regularWeekdays, requiredDates, breakdown[],
   *           attendedCount, requiredCount, eligible, reason }.
   */
  function computePlayerEligibility(playerId, name, regularWeekdays, attendanceByDate, month, todayISO) {
    const requiredDates = requiredDatesForMonth(month, regularWeekdays, todayISO);
    const breakdown = requiredDates.map((date) => {
      const e = entryFor(attendanceByDate, date, playerId);
      const present = !!(e && e.present);
      const paid = !!(e && e.paid);
      return { date, weekday: new Date(date + 'T00:00:00Z').getUTCDay(), present, paid, counted: present && paid };
    });
    const attendedCount = breakdown.filter((b) => b.counted).length;
    const requiredCount = requiredDates.length;
    const eligible = requiredCount > 0 && attendedCount === requiredCount;

    let reason = '';
    if (!eligible) {
      if (requiredCount === 0) reason = 'No required sessions yet this month';
      else {
        const miss = breakdown.find((b) => !b.counted);
        reason = miss
          ? (!miss.present ? 'Absent on ' + miss.date : 'Payment missing for ' + miss.date)
          : 'Not eligible';
      }
    }
    return {
      playerId, name,
      regularWeekdays: regularWeekdays.slice(),
      requiredDates, breakdown,
      attendedCount, requiredCount, eligible, reason,
    };
  }

  /**
   * Compute eligibility for every roster player who has a regular weekday.
   * Preserves any existing per-player `override` from prevPlayers.
   * Returns { month, computedAt, computedBy, players:[...] }.
   */
  function computeMonthEligibility(opts) {
    opts = opts || {};
    const roster = Array.isArray(opts.roster) ? opts.roster : [];
    const regulars = opts.regulars || {};
    const attendanceByDate = opts.attendance || {};
    const month = opts.month;
    const todayISO = opts.todayISO;
    const prev = Array.isArray(opts.prevPlayers) ? opts.prevPlayers : [];
    const prevById = new Map(prev.map((p) => [p.playerId, p]));

    const players = [];
    for (const r of roster) {
      if (!r || !r.id) continue;
      const wds = playerRegularWeekdays(regulars, r.id);
      if (!wds.length) continue; // only players with a regular schedule are auto-considered
      const rec = computePlayerEligibility(r.id, r.name, wds, attendanceByDate, month, todayISO);
      const prevRec = prevById.get(r.id);
      rec.override = (prevRec && prevRec.override) || null;
      players.push(rec);
    }
    return {
      month,
      computedAt: Number(opts.nowMs) || 0,
      computedBy: opts.computedBy || 'admin',
      players,
    };
  }

  /** Effective eligibility after an admin override is applied. */
  function effectiveEligible(rec) {
    if (rec && rec.override && typeof rec.override.eligible === 'boolean') return rec.override.eligible;
    return !!(rec && rec.eligible);
  }

  /**
   * Merge the auto-eligible players into the Monthly Draw participants list.
   * Manual/CSV participants (no `auto` flag) are preserved; auto entries are
   * rebuilt from the eligibility record (1 token = 1 ballot entry each). Dedupes
   * by id — a manual entry wins over an auto one. Pure — returns a new array.
   */
  function mergeEligibilityIntoParticipants(existing, eligibilityPlayers) {
    const manual = (Array.isArray(existing) ? existing : []).filter((p) => p && !p.auto);
    const manualIds = new Set(manual.map((p) => p.id));
    const out = manual.slice();
    (Array.isArray(eligibilityPlayers) ? eligibilityPlayers : []).forEach((rec) => {
      if (!effectiveEligible(rec)) return;
      if (manualIds.has(rec.playerId)) return;
      out.push({ id: rec.playerId, name: rec.name, phone: '', tubes: 4, tokens: 1, auto: true });
    });
    return out;
  }

  return {
    playerRegularWeekdays, requiredDatesForMonth, entryFor,
    computePlayerEligibility, computeMonthEligibility,
    effectiveEligible, mergeEligibilityIntoParticipants,
  };
});
