#!/usr/bin/env node
/* Tests for Malaysian phone normalization (public/phone.js).
 * The same number typed as 0123456789 / 60123456789 / +60123456789 must
 * collapse to ONE canonical identity so accounts can't be duplicated. */
'use strict';
const P = require('../public/phone.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── canonicalization: all three formats -> one key ──
const CANON = '60123456789';
check('local 0-prefix -> canonical', P.phoneCanonical('0123456789') === CANON);
check('60-prefix -> canonical', P.phoneCanonical('60123456789') === CANON);
check('+60-prefix -> canonical', P.phoneCanonical('+60123456789') === CANON);
check('spaces/dashes stripped', P.phoneCanonical('012-345 6789') === CANON);
check('bare mobile (no 0) -> canonical', P.phoneCanonical('123456789') === CANON);
check('leading/trailing spaces', P.phoneCanonical('  0123456789  ') === CANON);

// ── the three formats all match each other ──
check('phonesMatch 0 vs 60', P.phonesMatch('0123456789', '60123456789') === true);
check('phonesMatch 0 vs +60', P.phonesMatch('0123456789', '+60123456789') === true);
check('phonesMatch formatted vs plain', P.phonesMatch('012-345 6789', '+60 12-345 6789') === true);
check('phonesMatch different numbers -> false', P.phonesMatch('0123456789', '0129999999') === false);
check('phonesMatch empty -> false', P.phonesMatch('', '') === false);
check('phonesMatch invalid -> false', P.phonesMatch('abc', 'abc') === false);

// ── 011 (11-digit) mobile ──
check('011 local -> canonical', P.phoneCanonical('01112345678') === '601112345678');
check('011 60-prefix matches local', P.phonesMatch('01112345678', '601112345678') === true);

// ── validity ──
check('valid MY mobile', P.isValidMalaysianPhone('0123456789') === true);
check('too short -> invalid', P.isValidMalaysianPhone('0123') === false);
check('letters -> invalid', P.isValidMalaysianPhone('hello') === false);
check('empty -> invalid', P.isValidMalaysianPhone('') === false);
check('null -> invalid (no throw)', P.isValidMalaysianPhone(null) === false);
check('undefined -> invalid (no throw)', P.isValidMalaysianPhone(undefined) === false);
check('foreign +1 -> invalid', P.isValidMalaysianPhone('+14155550123') === false);

// ── normalize return shape ──
const r = P.normalizeMalaysianPhone('0123456789');
check('normalize ok=true', r.ok === true);
check('normalize canonical', r.canonical === CANON);
check('normalize display formatted', r.display === '+60 12-345 6789');
check('normalize error empty on ok', r.error === '');
const bad = P.normalizeMalaysianPhone('xyz');
check('normalize bad ok=false', bad.ok === false);
check('normalize bad has error', typeof bad.error === 'string' && bad.error.length > 0);
check('normalize bad canonical empty', bad.canonical === '');

// ── display + mask ──
check('phoneDisplay', P.phoneDisplay('60123456789') === '+60 12-345 6789');
check('phoneDisplay invalid -> empty', P.phoneDisplay('nope') === '');
check('maskPhone hides middle, keeps last 4', P.maskPhone('0123456789') === '+60 12-*** 6789');
check('maskPhone invalid falls back to tail', P.maskPhone('12') === '***');

// ── input tolerance ──
check('number input coerced', P.phoneCanonical(123456789) === CANON);
check('does not mutate: strings only', typeof P.phoneCanonical('0123456789') === 'string');

console.log(`\nphone.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
