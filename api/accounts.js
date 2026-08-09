'use strict';
/*
 * accounts.js — Player accounts v2 for the TZH site.
 *
 * Model (2026-07 overhaul, replaces the old username+PIN self-signup):
 *   - Login ID is the player's PHONE NUMBER (Malaysian, normalized so
 *     0123456789 / 60123456789 / +60123456789 are one identity — see phone.js).
 *   - Registration is a REQUEST, not an instant account: it lands as status
 *     'pending' and an admin must Approve (and LINK it to an EXISTING roster
 *     player), Reject (with a reason), or ask for More Info. Nobody is auto-active.
 *   - Password (not a PIN). Stored two ways:
 *       * pwHash/pwSalt — one-way scrypt, used for LOGIN verification.
 *       * pwEnc         — AES-256-GCM reversible copy (crypto.js) so an admin can
 *                         REVEAL a forgotten password without Gmail/SMS/WhatsApp OTP.
 *     Losing/omitting the encryption key degrades reveal only — login still works.
 *   - Statuses: pending | active | rejected | more_info | locked | suspended.
 *     Only 'active' may log in. Wrong-password attempts count up and auto-lock.
 *
 * Security: redactState strips the whole accounts array from every GET; the
 * decrypted password is returned ONLY by adminRevealPassword (admin re-confirms
 * their own password) and is NEVER stored in state, logs, or the audit trail.
 *
 * Legacy username+PIN accounts are migrated non-destructively by ensureAccountsV2
 * (status 'active', empty phone, forceChange) — an admin gives them a phone + temp
 * password to restore login. Their old pinHash/salt are kept, never deleted.
 */
const crypto = require('crypto');
const Phone = require('../public/phone.js');
const { encryptPassword, decryptPassword, hasKey } = require('./crypto.js');
const { pushAudit } = require('./audit.js');

const MAX_ACCOUNTS = 1000;
const MAX_PHOTO_LEN = 400000;    // ~300KB base64
const NAME_MAX = 40;
const PW_MIN = 6, PW_MAX = 100;
const LOCK_THRESHOLD = 5;        // failed logins before auto-lock

const LOGIN_OK_STATUSES = new Set(['active']);
const ALL_STATUSES = new Set(['pending', 'active', 'rejected', 'more_info', 'locked', 'suspended']);

const ACCOUNT_ACTIONS = new Set([
  'registerAccount', 'loginAccount', 'accountSession', 'updateAccount',
  'changePassword', 'accountStatus', 'logoutAccount', 'accountDrawInfo',
]);

const ADMIN_ACCOUNT_ACTIONS = new Set([
  'adminListAccounts', 'adminApproveAccount', 'adminRejectAccount', 'adminRequestMoreInfo',
  'adminRevealPassword', 'adminSetTempPassword', 'adminChangePassword', 'adminForceChange',
  'adminLockAccount', 'adminUnlockAccount', 'adminSuspendAccount', 'adminReactivateAccount',
  'adminLinkPlayer', 'adminCreateAccount', 'adminDeleteAccount', 'adminSetPhone',
]);

// ── validators (pure) ────────────────────────────────────────────────
function validateName(n) {
  const v = (n == null ? '' : String(n)).trim();
  if (!v) return { ok: false, error: 'Please enter a name.' };
  if (v.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` };
  return { ok: true, value: v };
}

function validatePhoto(photo) {
  if (photo == null || photo === '') return { ok: true, value: null };
  if (typeof photo !== 'string') return { ok: false, error: 'Invalid image.' };
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(photo)) return { ok: false, error: 'Invalid image.' };
  if (photo.length > MAX_PHOTO_LEN) return { ok: false, error: 'Image is too large.' };
  return { ok: true, value: photo };
}

function validatePhone(raw) {
  const r = Phone.normalizeMalaysianPhone(raw);
  return r.ok ? { ok: true, canonical: r.canonical, display: r.display } : { ok: false, error: r.error };
}

function validatePassword(pw) {
  const v = (pw == null ? '' : String(pw));
  if (v.length < PW_MIN) return { ok: false, error: `Password must be at least ${PW_MIN} characters.` };
  if (v.length > PW_MAX) return { ok: false, error: 'Password is too long.' };
  return { ok: true, value: v };
}

// ── lookups (pure) ───────────────────────────────────────────────────
function findById(accounts, id) {
  if (!Array.isArray(accounts) || !id) return null;
  return accounts.find((a) => a && a.id === id) || null;
}
function findByToken(accounts, token) {
  if (!Array.isArray(accounts) || !token) return null;
  return accounts.find((a) => a && a.token && a.token === token) || null;
}
function findByPhone(accounts, raw) {
  const c = Phone.phoneCanonical(raw);
  if (!c || !Array.isArray(accounts)) return null;
  return accounts.find((a) => a && a.phone === c) || null;
}

// ── crypto (scrypt one-way for login) ────────────────────────────────
function scryptHash(secret, salt) { return crypto.scryptSync(String(secret), String(salt), 64).toString('hex'); }
const hashPin = scryptHash;      // legacy alias kept for migrated records
function verifyHash(secret, hashHex, salt) {
  if (!hashHex || !salt) return false;
  const a = Buffer.from(scryptHash(secret, salt), 'hex');
  let b;
  try { b = Buffer.from(hashHex, 'hex'); } catch { return false; }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function verifyPin(pin, account) { return !!account && verifyHash(pin, account.pinHash, account.salt); }
function verifyPassword(pw, account) { return !!account && verifyHash(pw, account.pwHash, account.pwSalt); }

function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeId(prefix) { return prefix + crypto.randomBytes(8).toString('hex'); }
function makeTempPassword() {
  // human-friendly temp: e.g. "tzh-4816" — easy to read out over the phone.
  return 'tzh-' + (crypto.randomBytes(2).readUInt16BE(0) % 9000 + 1000);
}

// Encrypt for reveal, but NEVER block the flow if the key is missing/bad.
function encPasswordSafe(pw) {
  try { return encryptPassword(pw); } catch (e) { if (e && e.noKey) return null; return null; }
}
// Set both the login hash and the reveal blob from a plaintext password.
function setPassword(account, pw) {
  account.pwSalt = makeSalt();
  account.pwHash = scryptHash(pw, account.pwSalt);
  account.pwEnc = encPasswordSafe(pw);
  account.pwChangedAt = Date.now();
}

// ── client-facing shapes (never expose hashes / blobs / tokens) ──────
function rosterPlayer(roster, playerId) {
  return Array.isArray(roster) ? roster.find((r) => r && r.id === playerId) || null : null;
}

// Self view — returned only from token/credential-authenticated POST responses.
function publicAccount(account, roster) {
  const player = rosterPlayer(roster, account.playerId);
  return {
    id: account.id,
    phone: account.phoneDisplay || '',
    playerId: account.playerId || null,
    name: (player && player.name) || account.name || '',
    photo: (player && player.photo) || null,
    status: account.status || 'pending',
    forceChange: !!account.forceChange,
    tempPassword: !!account.tempPassword,
  };
}

// Status view — for the registration-status screen (no token needed, phone+password).
function statusView(account) {
  return {
    id: account.id,
    phone: account.phoneDisplay || '',
    status: account.status || 'pending',
    name: account.name || '',
    requestedAt: account.requestedAt || account.createdAt || null,
    updatedAt: account.updatedAt || null,
    approvedAt: account.approvedAt || null,
    rejectedReason: account.rejectedReason || null,
    moreInfoMsg: account.moreInfoMsg || null,
    suspendedReason: account.suspendedReason || null,
    lockedReason: account.lockedReason || null,
    forceChange: !!account.forceChange,
  };
}

// Rich admin view — status/flags/timestamps, link + password presence, but NO secrets.
function adminAccount(account, roster) {
  const player = rosterPlayer(roster, account.playerId);
  // Suggest an existing roster player to link, matching the typed name/hint.
  let suggestedPlayerId = null, suggestedPlayerName = null;
  if (!player) {
    const hint = String(account.playerHint || account.name || '').trim().toLowerCase();
    if (hint && Array.isArray(roster)) {
      const m = roster.find((r) => r && String(r.name || '').trim().toLowerCase() === hint);
      if (m) { suggestedPlayerId = m.id; suggestedPlayerName = m.name; }
    }
  }
  return {
    id: account.id,
    phone: account.phone || '',
    phoneDisplay: account.phoneDisplay || '',
    status: account.status || 'pending',
    name: (player && player.name) || account.name || '',
    photo: (player && player.photo) || null,
    playerId: account.playerId || null,
    hasPlayer: !!player,
    playerHint: account.playerHint || '',
    suggestedPlayerId, suggestedPlayerName,
    hasPassword: !!account.pwHash,
    hasEnc: !!account.pwEnc,
    canReveal: !!account.pwEnc && hasKey(),
    tempPassword: !!account.tempPassword,
    forceChange: !!account.forceChange,
    failedAttempts: account.failedAttempts || 0,
    lockedAt: account.lockedAt || null,
    lockedReason: account.lockedReason || null,
    suspendedAt: account.suspendedAt || null,
    suspendedReason: account.suspendedReason || null,
    lastLoginAt: account.lastLoginAt || null,
    pwChangedAt: account.pwChangedAt || null,
    requestedAt: account.requestedAt || account.createdAt || null,
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    approvedBy: account.approvedBy || null,
    approvedAt: account.approvedAt || null,
    rejectedBy: account.rejectedBy || null,
    rejectedAt: account.rejectedAt || null,
    rejectedReason: account.rejectedReason || null,
    moreInfoMsg: account.moreInfoMsg || null,
    moreInfoAt: account.moreInfoAt || null,
    source: account.source || 'self',
    legacyPin: !!account.legacyPin,
  };
}

// ── GET payload guard ────────────────────────────────────────────────
function redactState(state) {
  if (!state || typeof state !== 'object') return {};
  const { accounts, ...safe } = state;
  return safe;
}

// ── migration + array guards ─────────────────────────────────────────
function ensureArrays(state) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.roster)) state.roster = [];
}

// Lazily migrate legacy (v1 username+PIN) accounts to v2 in place. Non-destructive:
// keeps pinHash/salt, marks legacyPin, sets status active + forceChange so an admin
// can restore login by giving them a phone + temp password.
function ensureAccountsV2(state) {
  ensureArrays(state);
  const now = Date.now();
  for (const a of state.accounts) {
    if (!a || a.v >= 2) continue;
    a.v = 2;
    a.legacyPin = !!a.pinHash;
    a.status = 'active';
    if (a.phone == null) a.phone = '';
    if (a.phoneDisplay == null) a.phoneDisplay = '';
    if (a.pwHash == null) { a.pwHash = null; a.pwSalt = null; }
    if (a.pwEnc === undefined) a.pwEnc = null;
    a.tempPassword = !!a.tempPassword;
    a.forceChange = true;              // must set a real password once re-issued
    if (a.failedAttempts == null) a.failedAttempts = 0;
    a.lockedAt = a.lockedAt || null; a.lockedReason = a.lockedReason || null;
    a.suspendedAt = a.suspendedAt || null; a.suspendedReason = a.suspendedReason || null;
    a.requestedAt = a.requestedAt || a.createdAt || now;
    a.pwChangedAt = a.pwChangedAt || a.updatedAt || now;
    a.approvedBy = a.approvedBy || 'system'; a.approvedAt = a.approvedAt || a.createdAt || now;
    a.source = a.source || 'self';
    a.playerHint = a.playerHint || a.name || '';
  }
  return state;
}

// ── audit helper (adds actor + player label) ─────────────────────────
function audit(state, action, account, extra) {
  extra = extra || {};
  pushAudit(state, {
    action, admin: extra.admin || 'admin', at: Date.now(),
    target: { type: 'account', id: account ? account.id : null, label: (account && (account.name || account.phoneDisplay)) || '' },
    prevValue: extra.prevValue !== undefined ? extra.prevValue : null,
    newValue: extra.newValue !== undefined ? extra.newValue : null,
    note: extra.note || '',
  });
}

// ── public action handlers ───────────────────────────────────────────
function doRegister(state, body) {
  if (state.accounts.length >= MAX_ACCOUNTS) {
    return { status: 409, body: { error: 'Account limit reached. Please contact the administrator.' }, changed: false };
  }
  const ph = validatePhone(body.phone);
  if (!ph.ok) return { status: 400, body: { error: ph.error }, changed: false };
  const pw = validatePassword(body.password);
  if (!pw.ok) return { status: 400, body: { error: pw.error }, changed: false };
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== pw.value) {
    return { status: 400, body: { error: 'Passwords do not match.' }, changed: false };
  }

  const existing = findByPhone(state.accounts, ph.canonical);
  if (existing) {
    // Same number, any format — never create a duplicate.
    return { status: 409, body: { error: 'An account request already exists for this phone number.', status: existing.status }, changed: false };
  }

  const now = Date.now();
  const account = {
    id: makeId('acc_'), v: 2,
    phone: ph.canonical, phoneDisplay: ph.display,
    status: 'pending',
    pwHash: null, pwSalt: null, pwEnc: null,
    tempPassword: false, forceChange: false, failedAttempts: 0,
    lockedAt: null, lockedReason: null, suspendedAt: null, suspendedReason: null,
    lastLoginAt: null, pwChangedAt: now,
    requestedAt: now, createdAt: now, updatedAt: now,
    approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectedReason: null,
    moreInfoMsg: null, moreInfoAt: null,
    playerId: null, playerHint: (body.name != null ? String(body.name).trim().slice(0, NAME_MAX) : ''),
    name: (body.name != null ? String(body.name).trim().slice(0, NAME_MAX) : ''),
    token: null, source: 'self',
  };
  setPassword(account, pw.value);
  state.accounts = [...state.accounts, account];
  audit(state, 'account.register', account, { admin: 'self', newValue: 'pending' });
  return { status: 200, body: { ok: true, pending: true, account: statusView(account) }, changed: true };
}

function loginResultForStatus(account) {
  // Correct password but not active — steer the client to the status screen.
  return { status: 200, body: { ok: false, blocked: true, account: statusView(account) }, changed: false };
}

function doLogin(state, body) {
  const account = findByPhone(state.accounts, body.phone);
  if (!account || !account.pwHash) {
    return { status: 401, body: { error: 'No account found for that phone number, or no password set. Contact the administrator.' }, changed: false };
  }
  if (!verifyPassword(body.password, account)) {
    account.failedAttempts = (account.failedAttempts || 0) + 1;
    let locked = false;
    if (account.failedAttempts >= LOCK_THRESHOLD && account.status === 'active') {
      account.status = 'locked'; account.lockedAt = Date.now(); account.lockedReason = 'Too many failed sign-in attempts';
      account.token = null; locked = true;
      audit(state, 'account.autolock', account, { admin: 'system', newValue: 'locked' });
    }
    return { status: 401, body: { error: locked ? 'Account locked after too many attempts. Contact the administrator.' : 'Incorrect password.', locked }, changed: true };
  }
  // Correct password.
  account.failedAttempts = 0;
  if (!LOGIN_OK_STATUSES.has(account.status)) {
    return loginResultForStatus(account);
  }
  if (!account.token) account.token = makeToken();
  account.lastLoginAt = Date.now();
  return { status: 200, body: { ok: true, token: account.token, account: publicAccount(account, state.roster), forceChange: !!account.forceChange }, changed: true };
}

function doAccountStatus(state, body) {
  const account = findByPhone(state.accounts, body.phone);
  if (!account || !account.pwHash || !verifyPassword(body.password, account)) {
    return { status: 401, body: { error: 'Phone number or password is incorrect.' }, changed: false };
  }
  return { status: 200, body: { ok: true, account: statusView(account) }, changed: false };
}

function doSession(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account) return { status: 401, body: { error: 'Session expired.' }, changed: false };
  if (account.status !== 'active') { account.token = null; return { status: 401, body: { error: 'Account not active.', account: statusView(account) }, changed: true }; }
  return { status: 200, body: { ok: true, account: publicAccount(account, state.roster) }, changed: false };
}

function doUpdate(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account || account.status !== 'active') return { status: 401, body: { error: 'Session expired.' }, changed: false };

  let nameVal, photoVal, photoProvided = false;
  if (body.name !== undefined) {
    const r = validateName(body.name);
    if (!r.ok) return { status: 400, body: { error: r.error }, changed: false };
    nameVal = r.value;
  }
  if (body.photo !== undefined) {
    const r = validatePhoto(body.photo);
    if (!r.ok) return { status: 400, body: { error: r.error }, changed: false };
    photoVal = r.value; photoProvided = true;
  }
  if (nameVal !== undefined) account.name = nameVal;
  account.updatedAt = Date.now();
  // Mirror onto the LINKED existing roster player so the court display updates.
  const player = rosterPlayer(state.roster, account.playerId);
  if (player) {
    if (nameVal !== undefined) player.name = nameVal;
    if (photoProvided) player.photo = photoVal;
    if (player.accountId === undefined) player.accountId = account.id;
  }
  return { status: 200, body: { ok: true, account: publicAccount(account, state.roster) }, changed: true };
}

function doChangePassword(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account || account.status !== 'active') return { status: 401, body: { error: 'Session expired.' }, changed: false };
  if (!verifyPassword(body.currentPassword, account)) {
    return { status: 401, body: { error: 'Current password is incorrect.' }, changed: false };
  }
  const pw = validatePassword(body.newPassword);
  if (!pw.ok) return { status: 400, body: { error: pw.error }, changed: false };
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== pw.value) {
    return { status: 400, body: { error: 'Passwords do not match.' }, changed: false };
  }
  setPassword(account, pw.value);
  account.forceChange = false; account.tempPassword = false; account.updatedAt = Date.now();
  audit(state, 'account.password_change', account, { admin: 'self', note: 'self-service' });
  return { status: 200, body: { ok: true, account: publicAccount(account, state.roster) }, changed: true };
}

function doLogout(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account) return { status: 200, body: { ok: true }, changed: false };
  account.token = null;
  return { status: 200, body: { ok: true }, changed: true };
}

// A logged-in player's OWN draw eligibility — token-gated, self only. Never
// exposes any other player's attendance/payment (that data stays admin-only).
function doAccountDrawInfo(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account || account.status !== 'active') return { status: 401, body: { error: 'Session expired.' }, changed: false };
  const pid = account.playerId;

  // Monthly: read this player's row from the eligibility cache (if computed).
  let monthly = null;
  const me = state.monthlyEligibility;
  if (me && Array.isArray(me.players)) {
    const rec = me.players.find((p) => p && p.playerId === pid);
    if (rec) {
      const eligible = (rec.override && typeof rec.override.eligible === 'boolean') ? rec.override.eligible : !!rec.eligible;
      monthly = { month: me.month, eligible, reason: rec.reason || '', attendedCount: rec.attendedCount, requiredCount: rec.requiredCount, breakdown: rec.breakdown || [] };
    }
  }

  // Weekly: this player's own recent session attendance/payment + any wins.
  const att = state.attendance && typeof state.attendance === 'object' ? state.attendance : {};
  const draws = state.weeklyDraws && typeof state.weeklyDraws === 'object' ? state.weeklyDraws : {};
  const dates = Object.keys(att).sort().reverse().slice(0, 8);
  const weekly = [];
  for (const d of dates) {
    const e = att[d] && att[d].entries && att[d].entries[pid];
    if (!e) continue;
    const draw = draws[d];
    weekly.push({
      date: d, present: !!e.present, paid: !!e.paid, eligible: !!(e.present && e.paid),
      drawn: !!(draw && draw.status === 'drawn'),
      won: !!(draw && draw.winner && draw.winner.playerId === pid),
    });
  }
  return { status: 200, body: { ok: true, monthly, weekly }, changed: false };
}

function handleAccountAction(state, body) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    ensureAccountsV2(state);
    switch (body && body.action) {
      case 'registerAccount': return doRegister(state, body);
      case 'loginAccount':    return doLogin(state, body);
      case 'accountStatus':   return doAccountStatus(state, body);
      case 'accountSession':  return doSession(state, body);
      case 'updateAccount':   return doUpdate(state, body);
      case 'changePassword':  return doChangePassword(state, body);
      case 'accountDrawInfo': return doAccountDrawInfo(state, body);
      case 'logoutAccount':   return doLogout(state, body);
      default:                return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

// ── admin action handlers ────────────────────────────────────────────
function playerLinkedElsewhere(state, playerId, exceptAccountId) {
  return state.accounts.some((a) => a && a.playerId === playerId && a.id !== exceptAccountId);
}

function doAdminList(state) {
  const accounts = state.accounts
    .map((a) => adminAccount(a, state.roster))
    .sort((x, y) => (y.requestedAt || y.createdAt || 0) - (x.requestedAt || x.createdAt || 0));
  const counts = { pending: 0, active: 0, rejected: 0, more_info: 0, locked: 0, suspended: 0 };
  for (const a of accounts) if (counts[a.status] !== undefined) counts[a.status]++;
  return { status: 200, body: { ok: true, accounts, counts }, changed: false };
}

function doAdminApprove(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const playerId = body.playerId || account.playerId;
  if (!playerId) return { status: 400, body: { error: 'Select a player to link this account to.' }, changed: false };
  const player = rosterPlayer(state.roster, playerId);
  if (!player) return { status: 400, body: { error: 'That player no longer exists.' }, changed: false };
  if (playerLinkedElsewhere(state, playerId, account.id)) {
    return { status: 409, body: { error: 'That player is already linked to another account.' }, changed: false };
  }
  const prev = account.status;
  account.playerId = playerId;
  player.accountId = account.id;
  if (!account.name) account.name = player.name;
  account.status = 'active';
  account.approvedBy = body.admin || 'admin'; account.approvedAt = Date.now();
  account.rejectedReason = null; account.moreInfoMsg = null;
  account.failedAttempts = 0; account.updatedAt = Date.now();
  audit(state, 'account.approve', account, { prevValue: prev, newValue: 'active', note: 'linked ' + playerId });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminReject(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const reason = String(body.reason || '').trim();
  if (!reason) return { status: 400, body: { error: 'A rejection reason is required.' }, changed: false };
  const prev = account.status;
  account.status = 'rejected'; account.rejectedReason = reason;
  account.rejectedBy = body.admin || 'admin'; account.rejectedAt = Date.now();
  account.token = null; account.updatedAt = Date.now();
  audit(state, 'account.reject', account, { prevValue: prev, newValue: 'rejected', note: reason });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminMoreInfo(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const msg = String(body.message || '').trim();
  if (!msg) return { status: 400, body: { error: 'A message is required.' }, changed: false };
  const prev = account.status;
  account.status = 'more_info'; account.moreInfoMsg = msg; account.moreInfoAt = Date.now();
  account.updatedAt = Date.now();
  audit(state, 'account.more_info', account, { prevValue: prev, newValue: 'more_info', note: msg });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminReveal(state, body, opts) {
  // Identity confirm: the admin must re-enter the admin password on this action.
  // NOTE: this uses `confirmPassword` (NOT `password`) — the POST dispatcher strips
  // the top-level `password` (the admin auth field) before the handler runs, so a
  // reveal-confirm sent as `password` would never reach us. Keep them distinct.
  const adminPw = opts && opts.adminPassword;
  if (adminPw !== undefined && String(body.confirmPassword || '') !== String(adminPw)) {
    return { status: 401, body: { error: 'Admin password is incorrect.' }, changed: false };
  }
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  if (!account.pwEnc || !hasKey()) {
    return { status: 503, body: { error: 'Password reveal is unavailable for this account (no stored password or key). Set a temporary password instead.' }, changed: false };
  }
  let plaintext;
  try { plaintext = decryptPassword(account.pwEnc); }
  catch (e) { return { status: 503, body: { error: 'Could not decrypt the password.' }, changed: false }; }
  // Audit the REVEAL as an event only — never the plaintext.
  audit(state, 'account.password_reveal', account, { note: 'revealed to admin' });
  return { status: 200, body: { ok: true, password: plaintext }, changed: true };
}

function doAdminSetTemp(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  let temp = body.tempPassword != null && String(body.tempPassword) ? String(body.tempPassword) : makeTempPassword();
  const pw = validatePassword(temp);
  if (!pw.ok) return { status: 400, body: { error: pw.error }, changed: false };
  setPassword(account, pw.value);
  account.tempPassword = true; account.forceChange = true; account.updatedAt = Date.now();
  audit(state, 'account.temp_password', account, { note: 'temporary password set' });
  return { status: 200, body: { ok: true, tempPassword: pw.value, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminChangePassword(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const pw = validatePassword(body.newPassword);
  if (!pw.ok) return { status: 400, body: { error: pw.error }, changed: false };
  setPassword(account, pw.value);
  account.tempPassword = false; account.updatedAt = Date.now();
  audit(state, 'account.password_change', account, { note: 'admin set' });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminForceChange(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const prev = !!account.forceChange;
  account.forceChange = !!body.value; account.updatedAt = Date.now();
  audit(state, 'account.force_change', account, { prevValue: prev, newValue: account.forceChange });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function statusTransition(state, body, toStatus, action, opts) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const prev = account.status;
  account.status = toStatus;
  account.updatedAt = Date.now();
  if (toStatus === 'locked') { account.lockedAt = Date.now(); account.lockedReason = String(body.reason || 'Locked by admin'); account.token = null; }
  if (toStatus === 'suspended') { account.suspendedAt = Date.now(); account.suspendedReason = String(body.reason || 'Suspended by admin'); account.token = null; }
  if (toStatus === 'active') {
    if (prev === 'locked') { account.lockedAt = null; account.lockedReason = null; account.failedAttempts = 0; }
    if (prev === 'suspended') { account.suspendedAt = null; account.suspendedReason = null; }
  }
  audit(state, action, account, { prevValue: prev, newValue: toStatus, note: body.reason || '' });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminLinkPlayer(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const player = rosterPlayer(state.roster, body.playerId);
  if (!player) return { status: 400, body: { error: 'That player no longer exists.' }, changed: false };
  if (playerLinkedElsewhere(state, body.playerId, account.id)) {
    return { status: 409, body: { error: 'That player is already linked to another account.' }, changed: false };
  }
  const prev = account.playerId;
  // unlink old player
  const old = rosterPlayer(state.roster, prev);
  if (old && old.accountId === account.id) delete old.accountId;
  account.playerId = body.playerId; player.accountId = account.id;
  if (!account.name) account.name = player.name;
  account.updatedAt = Date.now();
  audit(state, 'account.link_player', account, { prevValue: prev, newValue: body.playerId });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminSetPhone(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const ph = validatePhone(body.phone);
  if (!ph.ok) return { status: 400, body: { error: ph.error }, changed: false };
  const dup = findByPhone(state.accounts, ph.canonical);
  if (dup && dup.id !== account.id) return { status: 409, body: { error: 'Another account already uses that phone number.' }, changed: false };
  const prev = account.phone;
  account.phone = ph.canonical; account.phoneDisplay = ph.display; account.updatedAt = Date.now();
  audit(state, 'account.set_phone', account, { prevValue: prev, newValue: ph.canonical });
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminCreate(state, body) {
  if (state.accounts.length >= MAX_ACCOUNTS) return { status: 409, body: { error: 'Account limit reached.' }, changed: false };
  const ph = validatePhone(body.phone);
  if (!ph.ok) return { status: 400, body: { error: ph.error }, changed: false };
  if (findByPhone(state.accounts, ph.canonical)) return { status: 409, body: { error: 'An account already exists for that phone number.' }, changed: false };
  const player = rosterPlayer(state.roster, body.playerId);
  if (!player) return { status: 400, body: { error: 'Select an existing player to link.' }, changed: false };
  if (playerLinkedElsewhere(state, body.playerId, null)) return { status: 409, body: { error: 'That player is already linked to another account.' }, changed: false };
  const nm = validateName(body.name || player.name);
  if (!nm.ok) return { status: 400, body: { error: nm.error }, changed: false };

  const now = Date.now();
  const account = {
    id: makeId('acc_'), v: 2, phone: ph.canonical, phoneDisplay: ph.display, status: 'active',
    pwHash: null, pwSalt: null, pwEnc: null, tempPassword: false, forceChange: false, failedAttempts: 0,
    lockedAt: null, lockedReason: null, suspendedAt: null, suspendedReason: null,
    lastLoginAt: null, pwChangedAt: now, requestedAt: now, createdAt: now, updatedAt: now,
    approvedBy: body.admin || 'admin', approvedAt: now, rejectedBy: null, rejectedAt: null, rejectedReason: null,
    moreInfoMsg: null, moreInfoAt: null, playerId: body.playerId, playerHint: player.name,
    name: nm.value, token: null, source: 'admin',
  };
  let temp = null;
  // Uses `newPassword` (NOT `password`) — the dispatcher strips the top-level
  // admin-auth `password`, so an account password sent as `password` never arrives.
  if (body.newPassword != null && String(body.newPassword)) {
    const pw = validatePassword(body.newPassword);
    if (!pw.ok) return { status: 400, body: { error: pw.error }, changed: false };
    setPassword(account, pw.value);
  } else {
    temp = makeTempPassword(); setPassword(account, temp); account.tempPassword = true; account.forceChange = true;
  }
  player.accountId = account.id;
  state.accounts = [...state.accounts, account];
  audit(state, 'account.admin_create', account, { newValue: 'active', note: 'linked ' + body.playerId });
  return { status: 200, body: { ok: true, tempPassword: temp, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminDelete(state, body) {
  const account = findById(state.accounts, body.id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  // v2: the roster player pre-exists independently — UNLINK it, don't delete it.
  const player = rosterPlayer(state.roster, account.playerId);
  if (player && player.accountId === account.id) delete player.accountId;
  state.accounts = state.accounts.filter((a) => a.id !== account.id);
  audit(state, 'account.delete', account, { note: 'unlinked player, account removed' });
  return { status: 200, body: { ok: true }, changed: true };
}

function handleAdminAccountAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    ensureAccountsV2(state);
    switch (body && body.action) {
      case 'adminListAccounts':    return doAdminList(state);
      case 'adminApproveAccount':  return doAdminApprove(state, body);
      case 'adminRejectAccount':   return doAdminReject(state, body);
      case 'adminRequestMoreInfo': return doAdminMoreInfo(state, body);
      case 'adminRevealPassword':  return doAdminReveal(state, body, opts);
      case 'adminSetTempPassword': return doAdminSetTemp(state, body);
      case 'adminChangePassword':  return doAdminChangePassword(state, body);
      case 'adminForceChange':     return doAdminForceChange(state, body);
      case 'adminLockAccount':     return statusTransition(state, body, 'locked', 'account.lock');
      case 'adminUnlockAccount':   return statusTransition(state, body, 'active', 'account.unlock');
      case 'adminSuspendAccount':  return statusTransition(state, body, 'suspended', 'account.suspend');
      case 'adminReactivateAccount': return statusTransition(state, body, 'active', 'account.reactivate');
      case 'adminLinkPlayer':      return doAdminLinkPlayer(state, body);
      case 'adminSetPhone':        return doAdminSetPhone(state, body);
      case 'adminCreateAccount':   return doAdminCreate(state, body);
      case 'adminDeleteAccount':   return doAdminDelete(state, body);
      default:                     return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

module.exports = {
  validateName, validatePhoto, validatePhone, validatePassword,
  findById, findByToken, findByPhone,
  scryptHash, hashPin, verifyHash, verifyPin, verifyPassword,
  publicAccount, statusView, adminAccount, redactState, ensureAccountsV2,
  ACCOUNT_ACTIONS, handleAccountAction, MAX_ACCOUNTS, LOCK_THRESHOLD,
  ADMIN_ACCOUNT_ACTIONS, handleAdminAccountAction,
};
