#!/usr/bin/env node
/* Tests for reversible password encryption (api/crypto.js).
 * Round-trips a password, verifies key-missing is a safe NoKeyError (never a
 * crash, never plaintext leakage), and that rotation (OLD key) decrypts. */
'use strict';
const crypto = require('crypto');
const C = require('../api/crypto.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY_B64 = crypto.randomBytes(32).toString('base64');

// ── round-trip with hex key ──
const blob = C.encryptPassword('hunter2', KEY_HEX);
check('blob has iv/ct/tag', !!(blob.iv && blob.ct && blob.tag));
check('blob has key version', blob.k === C.KEY_VERSION);
check('ciphertext is not plaintext', !JSON.stringify(blob).includes('hunter2'));
check('round-trip hex key', C.decryptPassword(blob, KEY_HEX) === 'hunter2');

// ── round-trip with base64 key ──
const blob2 = C.encryptPassword('p@ss WORD 123', KEY_B64);
check('round-trip base64 key', C.decryptPassword(blob2, KEY_B64) === 'p@ss WORD 123');

// ── wrong key fails (auth tag) but does not leak ──
let wrongThrew = false;
try { C.decryptPassword(blob, crypto.randomBytes(32).toString('hex')); } catch { wrongThrew = true; }
check('wrong key throws', wrongThrew);

// ── missing key -> NoKeyError (safe) ──
let noKeyThrew = null;
try { C.encryptPassword('x', ''); } catch (e) { noKeyThrew = e; }
check('encrypt with no key -> NoKeyError', noKeyThrew && noKeyThrew.noKey === true);
check('hasKey false for empty', C.hasKey('') === false);
check('hasKey true for valid hex', C.hasKey(KEY_HEX) === true);
check('hasKey false for short key', C.hasKey('abcd') === false);

// ── malformed blob ──
let badBlobThrew = false;
try { C.decryptPassword({ iv: 'x' }, KEY_HEX); } catch { badBlobThrew = true; }
check('decrypt malformed blob throws', badBlobThrew);
let nullBlobThrew = false;
try { C.decryptPassword(null, KEY_HEX); } catch { nullBlobThrew = true; }
check('decrypt null blob throws', nullBlobThrew);

// ── rotation: OLD key still decrypts ──
const oldBlob = C.encryptPassword('legacy', KEY_HEX);
const NEW_KEY = crypto.randomBytes(32).toString('hex');
check('rotation: new key + OLD fallback decrypts old blob',
  C.decryptPassword(oldBlob, NEW_KEY, KEY_HEX) === 'legacy');
let rotFail = false;
try { C.decryptPassword(oldBlob, NEW_KEY); } catch { rotFail = true; }
check('rotation: without OLD key, old blob fails (not a crash)', rotFail);

// ── unicode ──
const u = C.encryptPassword('café🌸密码', KEY_HEX);
check('unicode round-trip', C.decryptPassword(u, KEY_HEX) === 'café🌸密码');

console.log(`\ncrypto.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
