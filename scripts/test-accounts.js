#!/usr/bin/env node
/* Tests for the account v2 PURE helpers (api/accounts.js): validators, scrypt
 * hashing, lookups, client-facing shapes (no secrets), legacy migration, and the
 * action sets. The full register->approve->login flow lives in test-accounts-v2.js. */
'use strict';
const A = require('../api/accounts.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── validateName ──
check('name: valid', A.validateName('Harvey').ok === true);
check('name: trimmed', A.validateName('  Harvey  ').value === 'Harvey');
check('name: empty -> not ok', A.validateName('').ok === false);
check('name: 41 chars -> not ok', A.validateName('a'.repeat(41)).ok === false);
check('name: null -> not ok (no throw)', A.validateName(null).ok === false);

// ── validatePhoto ──
check('photo: null -> ok null', A.validatePhoto(null).ok === true && A.validatePhoto(null).value === null);
check('photo: jpeg data url -> ok', A.validatePhoto('data:image/jpeg;base64,/9j/abc').ok === true);
check('photo: non-image url -> not ok', A.validatePhoto('https://evil/x.png').ok === false);
check('photo: oversized -> not ok', A.validatePhoto('data:image/jpeg;base64,' + 'A'.repeat(500000)).ok === false);

// ── validatePhone (Malaysian) ──
check('phone: local ok, canonical', A.validatePhone('0123456789').canonical === '60123456789');
check('phone: +60 ok', A.validatePhone('+60123456789').ok === true);
check('phone: junk -> not ok', A.validatePhone('abc').ok === false);

// ── validatePassword ──
check('password: 6+ ok', A.validatePassword('secret').ok === true);
check('password: too short -> not ok', A.validatePassword('12345').ok === false);
check('password: null -> not ok', A.validatePassword(null).ok === false);

// ── scrypt hash/verify ──
{
  const salt = 'abc123';
  const h = A.scryptHash('secret', salt);
  check('scryptHash deterministic', A.scryptHash('secret', salt) === h);
  check('scryptHash differs by salt', A.scryptHash('secret', 'other') !== h);
  check('verifyPassword correct', A.verifyPassword('secret', { pwHash: h, pwSalt: salt }) === true);
  check('verifyPassword wrong', A.verifyPassword('nope', { pwHash: h, pwSalt: salt }) === false);
  check('verifyPassword missing hash -> false (no throw)', A.verifyPassword('x', {}) === false);
  check('verifyPin (legacy) still works', A.verifyPin('123456', { pinHash: A.hashPin('123456', salt), salt }) === true);
}

// ── lookups ──
{
  const accounts = [
    { id: 'a1', phone: '60123456789', token: 'tok1', playerId: 'p1' },
    { id: 'a2', phone: '60129999999', token: 'tok2', playerId: 'p2' },
  ];
  check('findById', A.findById(accounts, 'a2') === accounts[1]);
  check('findByToken', A.findByToken(accounts, 'tok1') === accounts[0]);
  check('findByToken empty -> null', A.findByToken(accounts, '') === null);
  check('findByPhone canonical match (0-format input)', A.findByPhone(accounts, '0123456789') === accounts[0]);
  check('findByPhone (+60 format input)', A.findByPhone(accounts, '+60 12-345 6789') === accounts[0]);
  check('findByPhone unknown -> null', A.findByPhone(accounts, '0100000000') === null);
  check('findByPhone non-array -> null', A.findByPhone(null, '0123456789') === null);
}

// ── publicAccount: self view, live name/photo, NO secrets ──
{
  const account = { id: 'a1', phone: '60123456789', phoneDisplay: '+60 12-345 6789', playerId: 'p1', name: 'Cache', status: 'active', token: 'secret', pwHash: 'h', pwSalt: 's', pwEnc: { iv: 'x' }, forceChange: true };
  const roster = [{ id: 'p1', name: 'Harvey Live', photo: 'data:image/jpeg;base64,XX' }];
  const pub = A.publicAccount(account, roster);
  check('publicAccount: live name', pub.name === 'Harvey Live');
  check('publicAccount: phone is display form', pub.phone === '+60 12-345 6789');
  check('publicAccount: status + forceChange surfaced', pub.status === 'active' && pub.forceChange === true);
  check('publicAccount: NEVER leaks pwHash/pwSalt/pwEnc/token',
    pub.pwHash === undefined && pub.pwSalt === undefined && pub.pwEnc === undefined && pub.token === undefined);
}

// ── adminAccount: rich view, still NO secrets ──
{
  const account = { id: 'a1', phone: '60123456789', phoneDisplay: '+60 12-345 6789', status: 'pending', playerId: null, name: 'Harvey', playerHint: 'Harvey', pwHash: 'h', pwSalt: 's', pwEnc: { iv: 'x' }, token: 'secret', requestedAt: 5, createdAt: 5 };
  const roster = [{ id: 'p9', name: 'Harvey', photo: null }];
  const a = A.adminAccount(account, roster);
  check('adminAccount: status', a.status === 'pending');
  check('adminAccount: hasPassword true, hasEnc true', a.hasPassword === true && a.hasEnc === true);
  check('adminAccount: suggests matching player by name', a.suggestedPlayerId === 'p9');
  check('adminAccount: NEVER leaks pwHash/pwSalt/pwEnc/token',
    a.pwHash === undefined && a.pwSalt === undefined && a.pwEnc === undefined && a.token === undefined);
}

// ── redactState strips the accounts array ──
{
  const state = { roster: [{ id: 'p1' }], accounts: [{ id: 'a1', pwHash: 'x', pwEnc: {} }], numCourts: 2 };
  const safe = A.redactState(state);
  check('redactState: accounts removed', safe.accounts === undefined);
  check('redactState: other fields kept', safe.numCourts === 2);
  check('redactState: does not mutate input', state.accounts.length === 1);
  check('redactState: null -> object (no throw)', typeof A.redactState(null) === 'object');
}

// ── ensureAccountsV2 migrates legacy username+PIN records ──
{
  const state = { roster: [], accounts: [{ id: 'a1', username: 'harvey', pinHash: 'HH', salt: 'SS', token: 't', playerId: 'pa_1', name: 'Harvey', createdAt: 100 }] };
  A.ensureAccountsV2(state);
  const m = state.accounts[0];
  check('migrate: v=2', m.v === 2);
  check('migrate: status active', m.status === 'active');
  check('migrate: legacyPin flagged', m.legacyPin === true);
  check('migrate: forceChange true', m.forceChange === true);
  check('migrate: empty phone', m.phone === '' && m.phoneDisplay === '');
  check('migrate: keeps pinHash/salt (non-destructive)', m.pinHash === 'HH' && m.salt === 'SS');
  check('migrate: pwEnc null', m.pwEnc === null);
  check('migrate: idempotent (second run no-op)', (A.ensureAccountsV2(state), state.accounts[0].v) === 2);
}

// ── action sets ──
check('ACCOUNT_ACTIONS has register/login/status/session/update/changePassword/logout',
  ['registerAccount', 'loginAccount', 'accountStatus', 'accountSession', 'updateAccount', 'changePassword', 'logoutAccount'].every(a => A.ACCOUNT_ACTIONS.has(a)));
check('ADMIN_ACCOUNT_ACTIONS has approve/reject/reveal/lock/suspend/link/create/delete',
  ['adminApproveAccount', 'adminRejectAccount', 'adminRevealPassword', 'adminLockAccount', 'adminSuspendAccount', 'adminLinkPlayer', 'adminCreateAccount', 'adminDeleteAccount'].every(a => A.ADMIN_ACCOUNT_ACTIONS.has(a)));
check('public/admin sets do not overlap',
  !A.ADMIN_ACCOUNT_ACTIONS.has('registerAccount') && !A.ACCOUNT_ACTIONS.has('adminListAccounts'));

console.log(`\naccount v2 helper tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
