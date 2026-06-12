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
      const phone = phoneCol !== -1 ? (cells[phoneCol] || '').trim() : '';
      if (tokens >= 1) result.participants.push({ name, phone, tokens });
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

  return { drawTokens, drawLeftover, tokensRemaining, spinOutcome, parseDrawCsv, buildBallot, pickWinnerIndex };
});
