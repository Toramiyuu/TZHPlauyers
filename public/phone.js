/*
 * phone.js — Malaysian phone-number normalization for account login IDs.
 * Loaded in the browser via <script src> (window.Phone) and required by Node tests.
 * No dependencies, no build step. Pure — never reads the clock or mutates inputs.
 *
 * A phone number is a player account's unique login ID. The same person may type
 * their number three ways — 0123456789 / 60123456789 / +60123456789 — and all
 * must resolve to ONE canonical identity so we never create duplicate accounts.
 *
 *   canonical = country-coded digits, no '+', e.g. "60123456789"  (the identity key)
 *   display   = cosmetic, e.g. "+60 12-345 6789"                  (never used for matching)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.Phone = api;                                                // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Canonical Malaysian mobile: 60 1X XXXXXXX(X) — "601" + 7..9 more digits
  // (national 01X-XXXX XXXX numbers, 10–11 local digits). Kept deliberately
  // permissive: this is a club sign-in, not a telco validator.
  const MOBILE_RE = /^601\d{7,9}$/;
  // Optional landline acceptance: 60 [3-9] XXXXXXX(X)
  const LANDLINE_RE = /^60[3-9]\d{7,8}$/;

  /**
   * Reduce any user input to digits plus a single optional leading '+'.
   * "+60 12-345 6789" -> "+60123456789"; "0123456789" -> "0123456789".
   */
  function cleanRaw(raw) {
    let s = (raw == null ? '' : String(raw)).trim();
    const plus = s.charAt(0) === '+';
    s = s.replace(/[^\d]/g, '');
    return plus ? '+' + s : s;
  }

  /**
   * normalizeMalaysianPhone(raw) -> { ok, canonical, display, error }
   * ok:false leaves canonical/display as '' and sets a human error.
   */
  function normalizeMalaysianPhone(raw) {
    const cleaned = cleanRaw(raw);
    let d = cleaned.charAt(0) === '+' ? cleaned.slice(1) : cleaned;
    if (!d) return { ok: false, canonical: '', display: '', error: 'Please enter a phone number.' };

    let canonical;
    if (d.charAt(0) === '0') {
      canonical = '60' + d.slice(1);          // local 0123… -> 60123…
    } else if (d.slice(0, 2) === '60') {
      canonical = d;                            // already country-coded
    } else if (d.charAt(0) === '1' && d.length >= 9 && d.length <= 10) {
      canonical = '60' + d;                     // bare mobile without leading 0
    } else {
      return { ok: false, canonical: '', display: '', error: 'Enter a Malaysian phone number, e.g. 012-345 6789.' };
    }

    if (!MOBILE_RE.test(canonical) && !LANDLINE_RE.test(canonical)) {
      return { ok: false, canonical: '', display: '', error: 'That doesn’t look like a valid Malaysian number.' };
    }
    return { ok: true, canonical, display: formatDisplay(canonical), error: '' };
  }

  /** Cosmetic "+60 12-345 6789" formatting from a canonical string. */
  function formatDisplay(canonical) {
    const c = String(canonical || '');
    if (c.slice(0, 2) !== '60' || c.length < 4) return c ? '+' + c : '';
    const nat = c.slice(2);                     // drop country code
    const firstTwo = nat.slice(0, 2);
    const rest = nat.slice(2);
    if (rest.length <= 4) return '+60 ' + firstTwo + (rest ? '-' + rest : '');
    const last4 = rest.slice(-4);
    const middle = rest.slice(0, -4);
    return '+60 ' + firstTwo + '-' + middle + ' ' + last4;
  }

  /** Canonical key or '' if the input isn't a valid Malaysian number. */
  function phoneCanonical(raw) {
    const r = normalizeMalaysianPhone(raw);
    return r.ok ? r.canonical : '';
  }

  /** Cosmetic display or '' if invalid. */
  function phoneDisplay(raw) {
    const r = normalizeMalaysianPhone(raw);
    return r.ok ? r.display : '';
  }

  /** True when two inputs are the same number regardless of format. Empty never matches. */
  function phonesMatch(a, b) {
    const ca = phoneCanonical(a);
    const cb = phoneCanonical(b);
    return !!ca && ca === cb;
  }

  function isValidMalaysianPhone(raw) {
    return normalizeMalaysianPhone(raw).ok;
  }

  /**
   * Partially hide a phone for display on player rows an admin can see but that
   * shouldn't broadcast full numbers, e.g. "+60 12-*** 6789". Falls back to a
   * masked tail of the raw input if it isn't a valid MY number.
   */
  function maskPhone(raw) {
    const c = phoneCanonical(raw);
    if (c) {
      const nat = c.slice(2);
      const firstTwo = nat.slice(0, 2);
      const last4 = nat.slice(-4);
      return '+60 ' + firstTwo + '-*** ' + last4;
    }
    const digits = (raw == null ? '' : String(raw)).replace(/[^\d]/g, '');
    if (digits.length < 4) return digits ? '***' : '';
    return '***' + digits.slice(-4);
  }

  return {
    normalizeMalaysianPhone, phoneCanonical, phoneDisplay, phonesMatch,
    isValidMalaysianPhone, formatDisplay, maskPhone,
  };
});
