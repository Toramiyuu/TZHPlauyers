#!/usr/bin/env node
/* Full-flow tests for account v2 (api/accounts.js): register-as-request ->
 * admin approve+link -> login by phone -> change/reveal password -> lock/suspend.
 * Sets ACCOUNT_ENC_KEY so reveal round-trips. */
'use strict';
const crypto = require('crypto');
process.env.ACCOUNT_ENC_KEY = crypto.randomBytes(32).toString('hex');
const A = require('../api/accounts.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

const ADMIN_PW = 'TZH123';
function freshState() {
  return {
    roster: [{ id: 'p0', name: 'Thomas', photo: null, points: 0 }, { id: 'p6', name: 'Kokyan', photo: null, points: 0 }],
    accounts: [], audit: [],
  };
}
const reg = (s, phone, password, name) => A.handleAccountAction(s, { action: 'registerAccount', phone, password, name });
const admin = (s, body) => A.handleAdminAccountAction(s, body, { adminPassword: ADMIN_PW });

// ── register creates a PENDING request, no token, no player ──
{
  const s = freshState();
  const r = reg(s, '0123456789', 'secret1', 'Harvey');
  check('register: 200 + pending', r.status === 200 && r.body.pending === true);
  check('register: no token issued', r.body.token === undefined);
  check('register: status pending in body', r.body.account.status === 'pending');
  check('register: account stored', s.accounts.length === 1 && s.accounts[0].status === 'pending');
  check('register: password hashed (not plaintext)', s.accounts[0].pwHash && s.accounts[0].pwHash !== 'secret1');
  check('register: reversible blob stored (key present)', !!s.accounts[0].pwEnc);
  check('register: NO roster player created', s.roster.length === 2);
  check('register: canonical phone stored', s.accounts[0].phone === '60123456789');
  check('register: audit entry', s.audit.some(a => a.action === 'account.register'));
}

// ── phone dedup across formats ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  check('dedup: +60 format blocked', reg(s, '+60123456789', 'other1', 'Harvey2').status === 409);
  check('dedup: 60 format blocked', reg(s, '60123456789', 'other1', 'Harvey3').status === 409);
  check('dedup: still one account', s.accounts.length === 1);
}

// ── password confirm mismatch ──
{
  const s = freshState();
  const r = A.handleAccountAction(s, { action: 'registerAccount', phone: '0123456789', password: 'secret1', confirmPassword: 'nope', name: 'H' });
  check('register: password mismatch -> 400', r.status === 400);
}

// ── login blocked while pending; status screen readable ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const login = A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' });
  check('login while pending: ok:false + blocked (not an error)', login.status === 200 && login.body.ok === false && login.body.blocked === true);
  check('login while pending: no token', login.body.token === undefined);
  const st = A.handleAccountAction(s, { action: 'accountStatus', phone: '60123456789', password: 'secret1' });
  check('accountStatus: correct creds -> pending', st.status === 200 && st.body.account.status === 'pending');
  check('accountStatus: wrong password -> 401', A.handleAccountAction(s, { action: 'accountStatus', phone: '0123456789', password: 'bad' }).status === 401);
}

// ── approve requires linking to an existing player ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  check('approve without player -> 400', admin(s, { action: 'adminApproveAccount', id }).status === 400);
  const appr = admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  check('approve+link -> 200 active', appr.status === 200 && s.accounts[0].status === 'active');
  check('approve: linked to existing player p6', s.accounts[0].playerId === 'p6');
  check('approve: player back-links accountId', s.roster.find(p => p.id === 'p6').accountId === id);
  check('approve: audit recorded', s.audit.some(a => a.action === 'account.approve'));
  // cannot link a player already linked elsewhere
  reg(s, '0129999999', 'secret2', 'Other');
  const id2 = s.accounts.find(a => a.phone === '60129999999').id;
  check('approve: player already linked -> 409', admin(s, { action: 'adminApproveAccount', id: id2, playerId: 'p6' }).status === 409);
}

// ── login works once active; forceChange surfaced; wrong password locks ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  const login = A.handleAccountAction(s, { action: 'loginAccount', phone: '+60123456789', password: 'secret1' });
  check('login active: ok + token', login.status === 200 && typeof login.body.token === 'string');
  check('login active: forceChange false', login.body.forceChange === false);
  const token = login.body.token;
  check('session: valid token', A.handleAccountAction(s, { action: 'accountSession', token }).status === 200);

  // 5 wrong attempts -> auto lock
  for (let i = 0; i < A.LOCK_THRESHOLD; i++) A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'WRONG' });
  check('auto-lock after threshold', s.accounts[0].status === 'locked');
  check('locked: correct password now blocked', A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).body.blocked === true);
  // admin unlock
  admin(s, { action: 'adminUnlockAccount', id });
  check('unlock -> active, attempts reset', s.accounts[0].status === 'active' && s.accounts[0].failedAttempts === 0);
  check('unlock: login works again', A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).status === 200);
}

// ── change password (self) ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  const token = A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).body.token;
  check('changePassword: wrong current -> 401', A.handleAccountAction(s, { action: 'changePassword', token, currentPassword: 'bad', newPassword: 'newpass1' }).status === 401);
  const cp = A.handleAccountAction(s, { action: 'changePassword', token, currentPassword: 'secret1', newPassword: 'newpass1', confirmPassword: 'newpass1' });
  check('changePassword: ok', cp.status === 200);
  check('changePassword: old password fails', A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).status === 401);
  check('changePassword: new password works', A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'newpass1' }).status === 200);
}

// ── admin reveal password (identity confirm + audit, no plaintext stored) ──
{
  const s = freshState();
  reg(s, '0123456789', 'topsecret', 'Harvey');
  const id = s.accounts[0].id;
  check('reveal: wrong admin password -> 401', admin(s, { action: 'adminRevealPassword', id, confirmPassword: 'WRONGADMIN' }).status === 401);
  const rv = admin(s, { action: 'adminRevealPassword', id, confirmPassword: ADMIN_PW });
  check('reveal: correct admin password -> plaintext', rv.status === 200 && rv.body.password === 'topsecret');
  check('reveal: audit logged WITHOUT plaintext',
    s.audit.some(a => a.action === 'account.password_reveal') &&
    !JSON.stringify(s.audit).includes('topsecret'));
}

// ── reveal unavailable without key -> 503 (login still works) ──
{
  const savedKey = process.env.ACCOUNT_ENC_KEY;
  delete process.env.ACCOUNT_ENC_KEY;
  const s = freshState();
  reg(s, '0123456789', 'nokeypw', 'Harvey');
  check('no key: register still succeeds', s.accounts.length === 1 && !!s.accounts[0].pwHash);
  check('no key: pwEnc is null', s.accounts[0].pwEnc === null);
  const id = s.accounts[0].id;
  check('no key: reveal -> 503', admin(s, { action: 'adminRevealPassword', id, confirmPassword: ADMIN_PW }).status === 503);
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  check('no key: login still works (uses scrypt hash)', A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'nokeypw' }).status === 200);
  process.env.ACCOUNT_ENC_KEY = savedKey;
}

// ── temp password + force change ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  const tp = admin(s, { action: 'adminSetTempPassword', id });
  check('temp: returns a temp password once', typeof tp.body.tempPassword === 'string' && tp.body.tempPassword.length >= 6);
  check('temp: forceChange set', s.accounts[0].forceChange === true && s.accounts[0].tempPassword === true);
  const login = A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: tp.body.tempPassword });
  check('temp: login with temp -> forceChange true', login.status === 200 && login.body.forceChange === true);
}

// ── reject with reason + more info ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  check('reject without reason -> 400', admin(s, { action: 'adminRejectAccount', id }).status === 400);
  admin(s, { action: 'adminRejectAccount', id, reason: 'Duplicate account' });
  check('reject: status + reason visible in status view', s.accounts[0].status === 'rejected');
  const st = A.handleAccountAction(s, { action: 'accountStatus', phone: '0123456789', password: 'secret1' });
  check('reject: player sees rejection reason', st.body.account.rejectedReason === 'Duplicate account');
  admin(s, { action: 'adminRequestMoreInfo', id, message: 'Please confirm your name' });
  check('moreInfo: status + message', s.accounts[0].status === 'more_info' && s.accounts[0].moreInfoMsg === 'Please confirm your name');
}

// ── suspend / reactivate ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  admin(s, { action: 'adminSuspendAccount', id, reason: 'Policy' });
  check('suspend: status suspended, login blocked', s.accounts[0].status === 'suspended' &&
    A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).body.blocked === true);
  admin(s, { action: 'adminReactivateAccount', id });
  check('reactivate: active + login ok', s.accounts[0].status === 'active' &&
    A.handleAccountAction(s, { action: 'loginAccount', phone: '0123456789', password: 'secret1' }).status === 200);
}

// ── admin create manual account (linked, temp password) ──
{
  const s = freshState();
  const r = admin(s, { action: 'adminCreateAccount', phone: '0123456789', name: 'Kokyan', playerId: 'p6' });
  check('adminCreate: 200 + temp password', r.status === 200 && typeof r.body.tempPassword === 'string');
  check('adminCreate: active + linked', s.accounts[0].status === 'active' && s.accounts[0].playerId === 'p6');
  check('adminCreate: dup phone blocked', admin(s, { action: 'adminCreateAccount', phone: '60123456789', name: 'X', playerId: 'p0' }).status === 409);
}

// ── delete UNLINKS the player, does not delete it (v2) ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'Harvey');
  const id = s.accounts[0].id;
  admin(s, { action: 'adminApproveAccount', id, playerId: 'p6' });
  admin(s, { action: 'adminDeleteAccount', id });
  check('delete: account removed', s.accounts.length === 0);
  check('delete: roster player KEPT (unlinked)', s.roster.some(p => p.id === 'p6' && p.accountId === undefined));
}

// ── set phone (dedup) ──
{
  const s = freshState();
  const r = admin(s, { action: 'adminCreateAccount', phone: '0123456789', name: 'Kokyan', playerId: 'p6' });
  const id = s.accounts[0].id;
  reg(s, '0129999999', 'secret2', 'Other');
  const id2 = s.accounts.find(a => a.phone === '60129999999').id;
  check('setPhone: dup -> 409', admin(s, { action: 'adminSetPhone', id: id2, phone: '0123456789' }).status === 409);
  check('setPhone: new number ok', admin(s, { action: 'adminSetPhone', id: id2, phone: '0177777777' }).status === 200);
}

// ── list + counts ──
{
  const s = freshState();
  reg(s, '0123456789', 'secret1', 'A');
  reg(s, '0129999999', 'secret2', 'B');
  admin(s, { action: 'adminApproveAccount', id: s.accounts[0].id, playerId: 'p6' });
  const r = admin(s, { action: 'adminListAccounts' });
  check('list: returns all accounts', r.body.accounts.length === 2);
  check('list: counts pending + active', r.body.counts.active === 1 && r.body.counts.pending === 1);
  check('list: no secrets', r.body.accounts.every(a => a.pwHash === undefined && a.pwEnc === undefined && a.token === undefined));
}

// ── robustness ──
check('null body -> safe', [400, 401].includes(A.handleAccountAction(freshState(), null).status));
check('unknown action -> 400', A.handleAccountAction(freshState(), { action: 'whoami' }).status === 400);
check('admin unknown id -> 404', admin(freshState(), { action: 'adminApproveAccount', id: 'nope', playerId: 'p6' }).status === 404);
check('admin null body -> 400 (no throw)', A.handleAdminAccountAction(freshState(), null, {}).status === 400);

console.log(`\naccount v2 flow tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
