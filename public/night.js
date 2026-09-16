/*
 * night.js — pure logic for "which night are we in?".
 * Loaded in the browser via <script src> (window.Night, AFTER session-draw.js) and
 * required by api/state.js + the Node tests. No DOM, no clock of its own: the
 * instant is ALWAYS injected so every function is deterministic under test.
 *
 * THE RULE: a night is owned by the day it STARTED, not the calendar day the clock
 * is in. The Friday social runs to ~12:30am, and the treasurer goes home, sleeps,
 * and tallies the payments the next afternoon — so Friday's night owns Saturday
 * 12:30am AND all of Saturday. Midnight is not a boundary anywhere in this app.
 *
 * Formally: the current night is the most recent game day D whose GAME_START_HOUR
 * has passed. Game days are Mon/Fri/Sun — SessionDraw.isDrawDay is the single
 * source of truth for that, so adding a night there adds it here too.
 *
 *   Fri 21:00 -> Fri     Sat 00:30 -> Fri     Sat 12:00 -> Fri     Sun 12:00 -> Fri
 *   Sun 21:00 -> Sun     Mon 00:30 -> Sun     Mon 11:59 -> Sun     Mon 19:59 -> Sun
 *   Mon 20:00 -> Mon     Tue..Thu  -> Mon     Fri 12:00 -> Mon     Fri 20:00 -> Fri
 *
 * The Sun->Mon pair is why the boundary is an hour and not a day: Monday afternoon
 * still belongs to SUNDAY's night, and only flips when Monday's session starts.
 * Sessions that start before GAME_START_HOUR are handled by the admin pressing
 * "Start tonight" (an explicit session-date change), not by moving this constant.
 *
 * Dates are ISO 'YYYY-MM-DD' in Malaysia time (fixed UTC+8, no DST); instants are
 * epoch ms UTC. `offsetHours` is injectable to match TZ_OFFSET_HOURS.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const SD = isNode ? require('./session-draw.js') : (root && root.SessionDraw);
  const api = factory(SD);
  if (isNode) module.exports = api;   // Node
  if (root) root.Night = api;         // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SD) {
  'use strict';

  // ── config ───────────────────────────────────────────────────────────
  // Wall-clock hour (Malaysia) at which a game day's night takes over from the
  // previous one. Play runs 9pm–12(:30)am, so 20:00 sits an hour before the
  // first shuttle and gives the previous night the longest possible tail to be
  // tallied in: a Sunday night stays current until 19:59 on Monday.
  const GAME_START_HOUR = 20;
  const DEFAULT_OFFSET_HOURS = 8;
  const MAX_LOOKBACK_DAYS = 14; // > a full week, so the search always terminates
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isValidISO(s) { return typeof s === 'string' && ISO_RE.test(s); }

  /** Game nights only: Mon/Fri/Sun, straight from the draw schedule. */
  function isGameDay(iso) { return isValidISO(iso) && !!SD.isDrawDay(iso); }

  /** Local (UTC+offset) calendar parts of an instant. */
  function localParts(nowMs, offsetHours) {
    const off = offsetHours == null ? DEFAULT_OFFSET_HOURS : Number(offsetHours);
    const d = new Date((Number(nowMs) || 0) + off * 3600 * 1000);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }

  /** The most recent game day STRICTLY before `iso`, or null if none within a fortnight. */
  function prevGameDay(iso) {
    if (!isValidISO(iso)) return null;
    for (let i = 1; i <= MAX_LOOKBACK_DAYS; i++) {
      const d = SD.addDaysISO(iso, -i);
      if (isGameDay(d)) return d;
    }
    return null;
  }

  /** The next game day STRICTLY after `iso`, or null. */
  function nextGameDay(iso) {
    if (!isValidISO(iso)) return null;
    for (let i = 1; i <= MAX_LOOKBACK_DAYS; i++) {
      const d = SD.addDaysISO(iso, i);
      if (isGameDay(d)) return d;
    }
    return null;
  }

  /** `iso` itself when it is a game day, else the game day before it. */
  function gameDayOnOrBefore(iso) {
    if (!isValidISO(iso)) return null;
    return isGameDay(iso) ? iso : prevGameDay(iso);
  }

  /**
   * The night that owns this instant — the whole point of the module.
   * A game day only takes over at GAME_START_HOUR; before that the previous
   * night is still current (so Monday afternoon is still Sunday's night).
   */
  function currentNight(nowMs, offsetHours, startHour) {
    const start = startHour == null ? GAME_START_HOUR : Number(startHour);
    const p = localParts(nowMs, offsetHours);
    if (isGameDay(p.date) && p.hour >= start) return p.date;
    return prevGameDay(p.date);
  }

  /**
   * Which night a stray record dated `iso` belongs to. An off-day record (the
   * ghost Saturday that the old midnight rollover created) folds back into the
   * game night that was running when it was written; a game-day record is
   * already its own night and stays put. Returns null when nothing precedes it.
   */
  function owningNight(iso) { return gameDayOnOrBefore(iso); }

  /** True when `iso` is an off-day that should fold into an earlier night. */
  function isStrayDate(iso) {
    const owner = owningNight(iso);
    return isValidISO(iso) && !!owner && owner !== iso;
  }

  /**
   * The sticky rollover target: the night to advance a stale `sessionDate` to,
   * or null for "do nothing". Never rewinds a future-scheduled session and never
   * re-fires on the current night — so it is safe to call on every cron tick.
   * This replaces "advance to today at midnight", which is what split a Friday
   * night in half and invented a Saturday session.
   */
  function nextSessionDate(sessionDate, nowMs, offsetHours, startHour) {
    const night = currentNight(nowMs, offsetHours, startHour);
    if (!night) return null;
    if (!sessionDate || sessionDate < night) return night;
    return null;
  }

  /**
   * Has this game day's session started yet? Drives the "Start tonight" button:
   * true when today is a game day, its start hour has not arrived, and the live
   * session is still sitting on the previous night.
   */
  function canStartTonight(sessionDate, nowMs, offsetHours, startHour) {
    const p = localParts(nowMs, offsetHours);
    if (!isGameDay(p.date)) return false;
    if (sessionDate === p.date) return false;      // already started
    if (sessionDate && sessionDate > p.date) return false; // scheduled ahead
    const start = startHour == null ? GAME_START_HOUR : Number(startHour);
    return p.hour < start;                          // after start the cron has it
  }

  /** Malaysia-local ISO date of an instant — the raw calendar day, NOT the night. */
  function localDate(nowMs, offsetHours) { return localParts(nowMs, offsetHours).date; }

  /**
   * Is this date worth a tap on a date strip? Nobody plays on a Tuesday, so a
   * Tuesday holds nothing to open and the calendars grey it out. The escape
   * hatch is `hasRecord`: a date that already carries something (a saved
   * session, payments, the night being shown) stays reachable whatever weekday
   * it fell on, so a one-off game night — or an old ghost date — is never
   * locked away behind a disabled button.
   */
  function isPickableDate(iso, hasRecord) {
    if (!isValidISO(iso)) return false;
    return isGameDay(iso) || !!hasRecord;
  }

  return {
    GAME_START_HOUR, DEFAULT_OFFSET_HOURS,
    isValidISO, isGameDay, isPickableDate, localParts, localDate,
    prevGameDay, nextGameDay, gameDayOnOrBefore,
    currentNight, owningNight, isStrayDate,
    nextSessionDate, canStartTonight,
  };
});
