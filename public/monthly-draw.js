/*
 * monthly-draw.js — pure logic for the Monthly Lucky Draw (per-spin prize game).
 * Loaded in the browser via <script src> (window.MonthlyDraw) and required by Node tests.
 * No dependencies, no build step.
 *
 * Model: 1 Lucky Draw Token per 4 tubes purchased; 1 token = 1 spin. Each spin rolls
 * independent odds for each prize (default 1st 1%, 2nd 3%, 3rd 5%, rest = no win).
 * Prizes are unlimited — every spin rolls the full odds.
 *   tokens   = floor(tubes / 4)
 *   leftover = tubes % 4   (carried forward when a month is closed)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.MonthlyDraw = api;                                          // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function _int(v) {
    const t = Math.floor(Number(v));
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  function _frac(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Lucky Draw Tokens earned: 1 per 4 tubes. */
  function drawTokens(tubes) { return Math.floor(_int(tubes) / 4); }

  /** Tubes left over after tokens are claimed (carried into next month). */
  function drawLeftover(tubes) { return _int(tubes) % 4; }

  /** Spins a customer has left: each spin deducts 4 tubes, so spins-left = floor(tubes / 4). */
  function tokensRemaining(customer) {
    customer = customer || {};
    return drawTokens(customer.tubes);
  }

  /**
   * Roll one spin against per-prize odds (fractions, e.g. {first:0.01,second:0.03,third:0.05}).
   * Cumulative bands: [0,first)->first, [first,first+second)->second,
   * [..,+third)->third, else 'none'. Order puts the rarest prize first.
   * @param {{first:number,second:number,third:number}} odds
   * @param {() => number} [rng]  defaults to Math.random; injectable for tests
   * @returns {'first'|'second'|'third'|'none'}
   */
  function spinOutcome(odds, rng) {
    odds = odds || {};
    rng = typeof rng === 'function' ? rng : Math.random;
    const f = _frac(odds.first), s = _frac(odds.second), t = _frac(odds.third);
    const r = rng();
    if (r < f) return 'first';
    if (r < f + s) return 'second';
    if (r < f + s + t) return 'third';
    return 'none';
  }

  // ── Ballot model (active) — each token = one raffle ticket ─────────────
  // A participant's name is entered `tokens` times. Winners are removed by id
  // so a person can win at most one prize.

  /**
   * Tokenise CSV text into rows of fields (RFC-4180): handles "quoted, fields",
   * "" escaped quotes, and newlines embedded inside quoted fields (Excel does
   * this for multi-line cells). Returns Array<Array<string>>.
   */
  function parseCsvRows(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\r') { /* ignore */ }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    row.push(cur); rows.push(row);
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    return rows;
  }

  /**
   * Parse a CSV export of the points sheet into draw participants.
   * Maps columns by header name: Name (required), Lucky Draw Token (tickets),
   * Phone number, Accumulated tubes (fallback: tickets = floor(tubes/4)).
   * Only people with >= 1 token are eligible; others are counted in `skipped`.
   * @returns {{participants:Array<{name,phone,tokens}>, skipped:number, error:string}}
   */
  function parseDrawCsv(text) {
    const result = { participants: [], skipped: 0, error: '' };
    if (!text || !String(text).trim()) { result.error = 'empty'; return result; }
    const rows = parseCsvRows(text);
    let hi = -1;
    for (let i = 0; i < rows.length; i++) { if (rows[i].some(c => c.trim() !== '')) { hi = i; break; } }
    if (hi === -1) { result.error = 'empty'; return result; }
    const headers = rows[hi].map(h => h.trim().toLowerCase());
    const findCol = (pred) => { for (let i = 0; i < headers.length; i++) if (pred(headers[i])) return i; return -1; };
    const nameCol = findCol(h => h === 'name' || (h.indexOf('name') !== -1 && h.indexOf('phone') === -1));
    const tokenCol = findCol(h => h.indexOf('lucky draw token') !== -1 || h === 'token' || h === 'tokens');
    const phoneCol = findCol(h => h.indexOf('phone') !== -1);
    const tubesCol = findCol(h => h.indexOf('accumulated tube') !== -1 || h === 'tubes' || h.indexOf('tube') !== -1);
    if (nameCol === -1) { result.error = 'no-name-column'; return result; }
    for (let i = hi + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (!cells.some(c => c.trim() !== '')) continue;
      const name = (cells[nameCol] || '').trim();
      if (!name) continue;
      let tokens = NaN;
      if (tokenCol !== -1) { const tv = (cells[tokenCol] || '').trim(); if (tv !== '') tokens = parseInt(tv, 10); }
      if (!Number.isFinite(tokens) && tubesCol !== -1) {
        const tubes = parseInt((cells[tubesCol] || '').trim(), 10);
        if (Number.isFinite(tubes)) tokens = drawTokens(tubes);
      }
      if (!Number.isFinite(tokens) || tokens < 0) tokens = 0;
      // Tube-centric model: prefer the Accumulated tubes column; fall back to tokens*4.
      let tubesOut = NaN;
      if (tubesCol !== -1) { const uv = (cells[tubesCol] || '').trim(); if (uv !== '') tubesOut = parseInt(uv, 10); }
      if (!Number.isFinite(tubesOut) || tubesOut < 0) tubesOut = tokens * 4;
      const phone = phoneCol !== -1 ? (cells[phoneCol] || '').trim() : '';
      if (tokens >= 1) result.participants.push({ name, phone, tokens, tubes: tubesOut });
      else result.skipped++;
    }
    return result;
  }

  /** Expand participants into a ticket array (name repeated per token), excluding ids. */
  function buildBallot(participants, excludeIds) {
    const ex = new Set(excludeIds || []);
    const out = [];
    (participants || []).forEach(p => {
      if (!p || ex.has(p.id)) return;
      const n = Math.max(0, Math.floor(Number(p.tokens) || 0));
      for (let k = 0; k < n; k++) out.push(p);
    });
    return out;
  }

  /** Pick a winning index in [0,len); -1 if empty. rng injectable for tests. */
  function pickWinnerIndex(len, rng) {
    len = Math.max(0, Math.floor(Number(len) || 0));
    if (len <= 0) return -1;
    rng = typeof rng === 'function' ? rng : Math.random;
    return Math.floor(rng() * len);
  }

  // ── Engagement + month carry-over helpers (2026-06-28 overhaul) ────────

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
  function withTokens(p) {
    p = p || {};
    const tubes = _int(p.tubes);
    return Object.assign({}, p, { tubes: tubes, tokens: drawTokens(tubes) });
  }

  /**
   * Close a month: each participant's tubes -> leftover (tubes%4) and tokens -> 0.
   * Everyone is kept (incl. tubes 0) so name(+phone) identity stays stable across months.
   */
  function carryOverParticipants(list) {
    return (list || []).map(function (p) {
      const left = drawLeftover(p && p.tubes);
      return Object.assign({}, p, { tubes: left, tokens: drawTokens(left) }); // drawTokens(0..3) === 0
    });
  }

  function _normName(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function _normPhone(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  /** Identity match: same name; if BOTH have a phone, phone (digits) must match too. */
  function matchParticipant(a, b) {
    a = a || {}; b = b || {};
    if (_normName(a.name) !== _normName(b.name)) return false;
    const pa = _normPhone(a.phone), pb = _normPhone(b.phone);
    if (pa && pb) return pa === pb;
    return true; // one or both phones missing -> match on name alone
  }

  /** Grouping key for the common case: normalized name (+ phone digits when present). */
  function participantKey(name, phone) {
    const ph = _normPhone(phone);
    return _normName(name) + (ph ? '|' + ph : '');
  }

  /**
   * Merge `incoming` into `existing` by identity (matchParticipant).
   * opts.add: sum tubes onto the matched person; otherwise replace tubes.
   * Unmatched incoming are appended (id left for the caller to assign).
   * Untouched existing are kept. Tokens are always re-derived from tubes.
   */
  function mergeParticipants(existing, incoming, opts) {
    opts = opts || {};
    const add = !!opts.add;
    const out = (existing || []).map(function (p) { return Object.assign({}, p); });
    (incoming || []).forEach(function (inc) {
      const tubesInc = _int(inc && inc.tubes);
      let hit = null;
      for (let i = 0; i < out.length; i++) { if (matchParticipant(out[i], inc)) { hit = out[i]; break; } }
      if (hit) {
        hit.tubes = add ? _int(hit.tubes) + tubesInc : tubesInc;
        hit.tokens = drawTokens(hit.tubes);
      } else {
        out.push(Object.assign({}, inc, { tubes: tubesInc, tokens: drawTokens(tubesInc) }));
      }
    });
    return out;
  }

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

  return {
    drawTokens, drawLeftover, tokensRemaining, spinOutcome, parseDrawCsv, buildBallot, pickWinnerIndex,
    ordinal, withTokens, carryOverParticipants, matchParticipant, participantKey, mergeParticipants,
    nextMonthKey, monthLabel, reindexRanks,
    validateSignup, unhandledCount, timeAgo,
  };
});
