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

  return { drawTokens, drawLeftover, tokensRemaining, spinOutcome };
});
