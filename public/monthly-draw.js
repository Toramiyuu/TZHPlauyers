/*
 * monthly-draw.js — assorted pure helpers shared by the browser and the Node
 * tests (window.MonthlyDraw). No dependencies, no build step.
 *
 * The file is named for the Shuttlecock token-ballot draw it was written for.
 * That draw was removed in 2026-09 and its ballot logic went with it; what is
 * left is the month/ordinal maths, the social-game sign-up validators and the
 * calendar join flow, which other features still use. Kept under the old name
 * so the <script src> and every `MonthlyDraw.*` call site stay put.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.MonthlyDraw = api;                                          // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── month + ordinal helpers ────────────────────────────────────────────

  /** Ordinal string: 1->1st, 2->2nd, 3->3rd, 4->4th; 11/12/13 -> th. */
  function ordinal(n) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return String(n);
    const s = Math.abs(x) % 100;
    const last = Math.abs(x) % 10;
    let suf = 'th';
    if (s < 11 || s > 13) {
      if (last === 1) suf = 'st';
      else if (last === 2) suf = 'nd';
      else if (last === 3) suf = 'rd';
    }
    return x + suf;
  }

  /** Return a copy of a participant with tokens derived from tubes (1 per 4). */
  /** "YYYY-MM" -> next month key, handling Dec->Jan rollover. */
  function nextMonthKey(m) {
    const parts = String(m || '').split('-');
    let y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo)) return String(m || '');
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
    return y + '-' + String(mo).padStart(2, '0');
  }

  const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  /** "YYYY-MM" -> "Month YYYY" (built from the key, never Date.now). */
  function monthLabel(m) {
    const parts = String(m || '').split('-');
    const y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return String(m || '');
    return _MONTHS[mo - 1] + ' ' + y;
  }

  /** Remove the past-draw entry at idx, returning a new array. Out-of-range idx -> unchanged copy. */
  function removeHistoryEntry(history, idx) {
    const list = Array.isArray(history) ? history.slice() : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return list;
    list.splice(idx, 1);
    return list;
  }

  /** Sort results by current rank and renumber 1..n (engagement winner removal re-rank). */
  function reindexRanks(list) {
    return (list || []).slice()
      .sort(function (a, b) { return (a.rank || 0) - (b.rank || 0); })
      .map(function (r, i) { return Object.assign({}, r, { rank: i + 1 }); });
  }

  // ── Social game sign-ups (2026-06-28) — public join flow ───────────────
  // Pure validators shared by the browser modal and the server endpoint, so
  // both reject the same bad input. enabledDays = array of weekday names that
  // are currently open for sign-up (e.g. ['Friday','Sunday','Monday']).

  /**
   * Validate a prospective player's sign-up. Returns {ok, error}; error is a
   * user-facing string ('' when ok). First failing rule wins.
   * @param {{name?:string, phone?:string, days?:string[]}} input
   * @param {string[]} enabledDays  weekday names currently open
   */
  function validateSignup(input, enabledDays) {
    input = input || {};
    const name = String(input.name == null ? '' : input.name).trim();
    const phone = String(input.phone == null ? '' : input.phone).trim();
    const days = input.days;
    const allowed = new Set(enabledDays || []);
    if (!name) return { ok: false, error: 'Please enter your name.' };
    if (name.length > 80) return { ok: false, error: 'Name is too long.' };
    if (!phone) return { ok: false, error: 'Please enter your phone number.' };
    if (!/\d/.test(phone)) return { ok: false, error: 'Please enter a valid phone number.' };
    if (!Array.isArray(days) || days.length === 0) return { ok: false, error: 'Please pick at least one game day.' };
    for (let i = 0; i < days.length; i++) {
      if (!allowed.has(days[i])) return { ok: false, error: 'Please pick a valid game day.' };
    }
    return { ok: true, error: '' };
  }

  /** Count sign-ups still awaiting review (the admin tab badge). Non-array -> 0. */
  function unhandledCount(signups) {
    if (!Array.isArray(signups)) return 0;
    let n = 0;
    for (let i = 0; i < signups.length; i++) { if (!signups[i] || !signups[i].handled) n++; }
    return n;
  }

  /**
   * Human "x ago" label. `now` is injected (never reads the clock) so the
   * browser passes its synced server time. Bands: <45s just now, <60m Nm,
   * <24h Nh, else Nd. Non-finite inputs -> ''.
   */
  function timeAgo(at, now) {
    const a = Number(at), n = Number(now);
    if (!Number.isFinite(a) || !Number.isFinite(n)) return '';
    let diff = n - a;
    if (diff < 0) diff = 0;
    if (diff / 1000 < 45) return 'just now';
    const m = diff / 60000;
    if (m < 60) return Math.round(m) + 'm ago';
    const h = diff / 3600000;
    if (h < 24) return Math.round(h) + 'h ago';
    return Math.round(diff / 86400000) + 'd ago';
  }

  // ── Calendar join flow (2026-06-29) — dates + skill validation ─────────
  // Shared by the browser calendar and the server submit endpoint so both
  // enforce identical rules. All date math is deterministic (no clock reads):
  // the caller injects today/max derived from the SERVER clock.

  const SKILLS = ['Beginner', 'Intermediate', 'Advanced'];
  const WD_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const _ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /** True only for a real YYYY-MM-DD that round-trips (rejects 2026-02-30 etc.). */
  function isValidISO(s) {
    if (typeof s !== 'string') return false;
    const m = _ISO_RE.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  /** JS weekday 0=Sun..6=Sat for an ISO date; -1 if unparseable. */
  function isoWeekday(iso) {
    const m = _ISO_RE.exec(String(iso));
    if (!m) return -1;
    return new Date(+m[1], +m[2] - 1, +m[3]).getDay();
  }

  /** Weekday name ('Sunday'..'Saturday') for an ISO date; '' if unparseable. */
  function weekdayName(iso) {
    const w = isoWeekday(iso);
    return w >= 0 ? WD_NAMES[w] : '';
  }

  /**
   * Add n months to an ISO date, clamping the day to the target month's last
   * day (2026-11-30 + 3 -> 2027-02-28, never overflowing into March). Pure +
   * deterministic so client and server compute the SAME booking window bound.
   */
  function addMonthsISO(iso, n) {
    const m = _ISO_RE.exec(String(iso));
    if (!m) return String(iso);
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    const total = y * 12 + mo + Math.trunc(Number(n) || 0);
    const ny = Math.floor(total / 12);
    const nmo = ((total % 12) + 12) % 12;
    const lastDay = new Date(ny, nmo + 1, 0).getDate();
    const nd = Math.min(d, lastDay);
    return ny + '-' + String(nmo + 1).padStart(2, '0') + '-' + String(nd).padStart(2, '0');
  }

  /**
   * Validate a calendar join request. Returns {ok, error, clean?} where clean =
   * {name, phone, skill, dates:uniqueSorted(≤12), days:uniqueWeekdayNames}.
   * First failing rule wins; error is user-facing.
   * @param {{name?,phone?,skill?,dates?:string[]}} input
   * @param {{enabledWeekdays?:number[], todayISO?:string, maxISO?:string}} opts
   */
  function validateJoinRequest(input, opts) {
    input = input || {};
    opts = opts || {};
    const name = String(input.name == null ? '' : input.name).trim();
    const phone = String(input.phone == null ? '' : input.phone).trim();
    const skill = String(input.skill == null ? '' : input.skill).trim();
    const dates = input.dates;
    const enabled = new Set(Array.isArray(opts.enabledWeekdays) ? opts.enabledWeekdays : []);
    const todayISO = String(opts.todayISO || '');
    const maxISO = String(opts.maxISO || '');

    if (!name) return { ok: false, error: 'Please enter your name.' };
    if (name.length > 80) return { ok: false, error: 'Name is too long.' };
    if (!phone) return { ok: false, error: 'Please enter your phone number.' };
    if (!/\d/.test(phone)) return { ok: false, error: 'Please enter a valid phone number.' };
    if (SKILLS.indexOf(skill) === -1) return { ok: false, error: 'Please choose your skill level.' };
    if (!Array.isArray(dates) || dates.length === 0) return { ok: false, error: 'Please pick at least one date.' };

    const seen = new Set();
    const cleanDates = [];
    for (let i = 0; i < dates.length; i++) {
      const iso = String(dates[i] == null ? '' : dates[i]);
      if (!isValidISO(iso)) return { ok: false, error: 'Please pick a valid date.' };
      if (todayISO && iso < todayISO) return { ok: false, error: 'That date has already passed.' };
      if (maxISO && iso > maxISO) return { ok: false, error: 'That date is too far ahead.' };
      if (!enabled.has(isoWeekday(iso))) return { ok: false, error: 'Please pick a valid game day.' };
      if (!seen.has(iso)) { seen.add(iso); cleanDates.push(iso); }
    }
    cleanDates.sort();
    const capped = cleanDates.slice(0, 12); // payload-growth guard
    const days = [];
    const dseen = new Set();
    capped.forEach((iso) => { const nm = weekdayName(iso); if (nm && !dseen.has(nm)) { dseen.add(nm); days.push(nm); } });
    return { ok: true, error: '', clean: { name, phone, skill, dates: capped, days } };
  }

  // Group sign-up: one person brings friends, everyone shares one set of dates.
  const MAX_PARTY = 5; // 1 organiser + up to 4 friends

  /**
   * Validate a multi-person group join request. `input.people` is an array of
   * {name,phone,skill}; `input.dates` is the ONE date set they all share. Each
   * person is validated with validateJoinRequest (so the rules live in one
   * place). Returns {ok, error, clean:{list:[{name,phone,skill,dates,days,
   * broughtBy?}]}}. Person 0 is the organiser (no broughtBy); friends carry
   * broughtBy = organiser's name. With no `people[]`, falls back to a single
   * validateJoinRequest so old single-person callers keep working.
   * @param {{people?:Array,dates?:string[],name?,phone?,skill?}} input
   * @param {{enabledWeekdays?:number[], todayISO?:string, maxISO?:string}} opts
   */
  function validateJoinRequests(input, opts) {
    input = input || {};
    if (!Array.isArray(input.people)) {
      const one = validateJoinRequest(input, opts);
      return one.ok ? { ok: true, error: '', clean: { list: [one.clean] } } : one;
    }
    if (input.people.length === 0) return { ok: false, error: 'Please add at least one person.' };
    const people = input.people.slice(0, MAX_PARTY);
    const list = [];
    let organiser = '';
    for (let i = 0; i < people.length; i++) {
      const p = people[i] || {};
      const one = validateJoinRequest({ name: p.name, phone: p.phone, skill: p.skill, dates: input.dates }, opts);
      if (!one.ok) return one;
      if (i === 0) organiser = one.clean.name;
      else one.clean.broughtBy = organiser;
      list.push(one.clean);
    }
    return { ok: true, error: '', clean: { list } };
  }

  return {
    ordinal, nextMonthKey, monthLabel, reindexRanks, removeHistoryEntry,
    validateSignup, unhandledCount, timeAgo,
    SKILLS, isValidISO, isoWeekday, weekdayName, addMonthsISO, validateJoinRequest, validateJoinRequests,
  };
});
