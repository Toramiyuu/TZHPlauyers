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

  /** Add n days to an ISO date. Pure; returns the input unchanged if unparseable. */
  function addDaysISO(iso, n) {
    const m = _ISO_RE.exec(String(iso));
    if (!m) return String(iso);
    const dt = new Date(+m[1], +m[2] - 1, +m[3] + (Math.trunc(Number(n)) || 0));
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }

  // ── the next session ("Coming soon" on the viewer) ────────────────────
  // Between nights the hall screen used to render an EMPTY court grid: no
  // cards, just the header and a "Live" dot, which reads as broken. These
  // helpers answer "what's on next?" from the configured game days, so the
  // screen can show the date, time, level and how many places are left.

  const MAX_SEARCH_DAYS = 400; // a year+ — enough to find the next enabled day, or give up

  /**
   * Coerce one socialGames row to a full game day. `level` and `capacity` are
   * later additions, so old saved rows have neither: level defaults to '' (the
   * card just omits the line) and capacity to 0, meaning "no cap set" — which
   * renders as "open" rather than a misleading "0 slots left".
   */
  function normalizeGameDay(g) {
    const row = g && typeof g === 'object' ? g : {};
    const wd = Number.isFinite(row.weekday) ? row.weekday : WD_NAMES.indexOf(row.day);
    const cap = Math.floor(Number(row.capacity));
    return {
      id: String(row.id || ''),
      day: WD_NAMES[wd] || String(row.day || ''),
      weekday: wd >= 0 && wd <= 6 ? wd : -1,
      time: String(row.time || ''),
      level: String(row.level || ''),
      capacity: Number.isFinite(cap) && cap > 0 ? cap : 0,
      enabled: !!row.enabled,
    };
  }

  /**
   * The next enabled game day on or after `fromISO`, as {date, game}, or null.
   * `fromISO` is included, so on a Friday the answer is that same Friday — the
   * viewer shows tonight's session all day until it actually starts.
   */
  function nextGameDate(games, fromISO) {
    if (!isValidISO(fromISO)) return null;
    const byWeekday = _gamesByWeekday(games);
    if (!byWeekday.size) return null;
    for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
      const iso = addDaysISO(fromISO, i);
      const g = byWeekday.get(isoWeekday(iso));
      if (g) return { date: iso, game: g };
    }
    return null;
  }

  /** How many people hold a place on `iso`. One signup row = one person. */
  function signupsOnDate(signups, iso) {
    if (!isValidISO(iso) || !Array.isArray(signups)) return 0;
    let n = 0;
    for (const s of signups) {
      if (s && Array.isArray(s.dates) && s.dates.indexOf(iso) > -1) n++;
    }
    return n;
  }

  /**
   * Everything the "Coming soon" card needs, or null when no game day is open.
   * Returns { date, day, time, level, capacity, taken, slotsLeft, full }.
   * capacity 0 means no cap was configured: slotsLeft is then null (the card
   * says "Open" instead of a number) and `full` is never true.
   * NOTE the shape carries COUNTS only, never a name or a phone number — it is
   * built for the public GET, which anyone with the site code can read.
   */
  function upcomingSession(games, signups, fromISO) {
    const hit = nextGameDate(games, fromISO);
    if (!hit) return null;
    const g = hit.game;
    const taken = signupsOnDate(signups, hit.date);
    const slotsLeft = g.capacity > 0 ? Math.max(0, g.capacity - taken) : null;
    return {
      date: hit.date,
      day: g.day,
      time: g.time,
      level: g.level,
      capacity: g.capacity,
      taken,
      slotsLeft,
      full: g.capacity > 0 && slotsLeft === 0,
    };
  }

  // ── "Coming soon" on a clock (automatic hall-screen mode) ─────────────
  // The takeover used to be a switch someone had to remember to flip twice a
  // week. These helpers answer it from the game days instead: the card is up
  // from the end of the last night's play until an hour before the next
  // session's first shuttle (Friday 9pm -> the courts come back at 8pm Friday).
  // Everything here is pure and the instant is always injected, so the viewer,
  // the admin card and the tests all agree on what the screen is doing.

  const SOON_LEAD_MIN = 60;       // the card comes down this long before the start
  const SOON_PLAY_HOURS = 4;      // a 9pm start owns the screen until 1am
  const SOON_DEFAULT_START = 21 * 60; // 9pm — used when a game day's time is unreadable
  const SOON_TZ_OFFSET = 8;       // Asia/Kuala_Lumpur, no DST

  /**
   * Minutes past midnight the session STARTS, read out of the free-text time
   * field admins type ("9–11pm", "9pm", "8.30pm - 11pm", "21:00"). Returns null
   * when there is no number to read at all.
   *
   * am/pm is taken from the first marker at or after the start number, so
   * "9–11pm" is 9pm (the marker on the END time governs both). With no marker
   * anywhere an hour of 13+ is a 24-hour clock and anything lower is evening —
   * the club plays at night, so a bare "9–11" means 9pm, never 9am.
   */
  function parseStartMinutes(time) {
    const s = String(time == null ? '' : time).toLowerCase();
    const m = /(\d{1,2})\s*[:.]?\s*(\d{2})?/.exec(s);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mi = m[2] == null ? 0 : parseInt(m[2], 10);
    if (!Number.isFinite(h) || h > 23 || !Number.isFinite(mi) || mi > 59) return null;
    const mark = /(am|pm)/.exec(s.slice(m.index + m[0].length));
    if (mark) {
      if (mark[1] === 'pm') h = h === 12 ? 12 : h + 12;
      else h = h === 12 ? 0 : h;
    } else if (h <= 12) {
      h = h === 12 ? 12 : h + 12;
    }
    if (h > 23) return null;
    return h * 60 + mi;
  }

  /** Epoch ms of the first shuttle on `iso`, Malaysia wall-clock. */
  function gameStartInstant(iso, time, offsetHours) {
    const m = _ISO_RE.exec(String(iso));
    if (!m) return NaN;
    const mins = parseStartMinutes(time);
    const start = mins == null ? SOON_DEFAULT_START : mins;
    const off = offsetHours == null ? SOON_TZ_OFFSET : Number(offsetHours);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, start) - off * 3600 * 1000;
  }

  /** Malaysia-local calendar date of an instant — the clock's own idea of today. */
  function mytDateOf(nowMs, offsetHours) {
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return '';
    const off = offsetHours == null ? SOON_TZ_OFFSET : Number(offsetHours);
    return new Date(now + off * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** Enabled game days as weekday -> row, the same shape nextGameDate walks. */
  function _gamesByWeekday(games) {
    const byWeekday = new Map();
    (Array.isArray(games) ? games : []).map(normalizeGameDay)
      .filter(g => g.enabled && g.weekday >= 0)
      .forEach(g => { if (!byWeekday.has(g.weekday)) byWeekday.set(g.weekday, g); });
    return byWeekday;
  }

  /**
   * The most recent enabled game day whose start has already passed, as
   * {date, game, startAt}, or null. Walking back by START (not by date) is what
   * keeps a Sunday night that ran past midnight in charge of the screen: at
   * 00:30 on Monday, Monday's own 9pm has not happened yet, so Sunday answers.
   */
  function lastStartedGame(games, fromISO, nowMs, offsetHours) {
    if (!isValidISO(fromISO) || !Number.isFinite(Number(nowMs))) return null;
    const byWeekday = _gamesByWeekday(games);
    if (!byWeekday.size) return null;
    for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
      const iso = addDaysISO(fromISO, -i);
      const g = byWeekday.get(isoWeekday(iso));
      if (!g) continue;
      const startAt = gameStartInstant(iso, g.time, offsetHours);
      if (startAt <= Number(nowMs)) return { date: iso, game: g, startAt };
    }
    return null;
  }

  /**
   * What the hall screen should be doing at `nowMs` on automatic:
   *   { on, nextDate, nextStartAt, changesAt }
   * `on` true = show "Coming soon"; changesAt is the instant `on` flips (null
   * when nothing is scheduled, so nothing will ever change it).
   *
   * The instant is the ONLY input: "today" is derived from it rather than passed
   * in, so a stale server date and a running clock can never disagree about
   * which night the screen is in.
   */
  function comingSoonStatus(games, nowMs, offsetHours) {
    // A missing clock reads as 0 through Number(), which would put the screen in
    // 1970 and answer "Coming soon" forever — so demand a real instant.
    const now = nowMs == null ? NaN : Number(nowMs);
    const off = { on: false, nextDate: null, nextStartAt: null, changesAt: null };
    if (!Number.isFinite(now) || now <= 0) return off;
    const todayISO = mytDateOf(now, offsetHours);
    const playMs = SOON_PLAY_HOURS * 3600 * 1000;
    const leadMs = SOON_LEAD_MIN * 60 * 1000;
    const last = lastStartedGame(games, todayISO, now, offsetHours);
    const next = nextGameDate(games, todayISO);   // today counts as its own next
    const nextStartAt = next ? gameStartInstant(next.date, next.game.time, offsetHours) : null;
    const base = { nextDate: next ? next.date : null, nextStartAt };
    // Tonight's session owns the screen from the lead-in until play is over; so
    // does a session that started yesterday and is still inside its window.
    const holder = (nextStartAt != null && now >= nextStartAt - leadMs) ? { startAt: nextStartAt }
      : (last && now < last.startAt + playMs) ? last : null;
    if (holder) return Object.assign(base, { on: false, changesAt: holder.startAt + playMs });
    if (nextStartAt == null) return off;
    return Object.assign(base, { on: true, changesAt: nextStartAt - leadMs });
  }

  /** Just the answer: should the viewer be on "Coming soon" at `nowMs`? */
  function comingSoonAuto(games, nowMs, offsetHours) {
    return comingSoonStatus(games, nowMs, offsetHours).on;
  }

  /**
   * The stored hall-screen mode, tolerant of what is actually in Redis:
   * 'auto' | 'on' | 'off'. Sites saved before automatic mode existed carry only
   * the old `comingSoon` boolean — a true there was a deliberate takeover and
   * stays on until someone picks a mode; anything else starts on automatic.
   */
  function comingSoonMode(state) {
    const s = state || {};
    const mode = String(s.comingSoonMode == null ? '' : s.comingSoonMode);
    if (mode === 'auto' || mode === 'on' || mode === 'off') return mode;
    return s.comingSoon === true ? 'on' : 'auto';
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
    SKILLS, isValidISO, isoWeekday, weekdayName, addMonthsISO, addDaysISO, validateJoinRequest, validateJoinRequests,
    normalizeGameDay, nextGameDate, signupsOnDate, upcomingSession,
    SOON_LEAD_MIN, SOON_PLAY_HOURS, parseStartMinutes, gameStartInstant, mytDateOf,
    lastStartedGame, comingSoonStatus, comingSoonAuto, comingSoonMode,
  };
});
