'use strict';
/*
 * Simple user accounts for the TZH site.
 *
 * Design (decided with the user 2026-06-29):
 *   - Open self-signup (anyone past the daily site-access code can register).
 *   - Login is `username + 6-digit PIN`. Username is the immutable login handle;
 *     the editable display name + photo live on the linked ROSTER player, so a
 *     profile edit flows straight onto the live court display.
 *   - "New account = new player": registering appends a roster player and links
 *     it to the account via `playerId` (and the player back via `accountId`).
 *
 * Security:
 *   - PINs are never stored in clear: salted scrypt hash + constant-time compare.
 *     (A 6-digit PIN is a tiny keyspace by design — this stops casual disclosure
 *     of the stored blob, not a determined offline attacker. No lockout: a club
 *     app, not a bank.)
 *   - A random session token is returned on register/login; the client stores it
 *     and replays it for profile edits. `redactState` strips the entire accounts
 *     array (hashes, salts, tokens) from every GET payload so nothing leaks.
 *
 * handleAccountAction(state, body) is the single dispatch the GET-gated POST
 * endpoint calls for any ACCOUNT_ACTIONS verb. It mutates `state` in place and
 * returns {status, body, changed}; the caller persists only when changed.
 * It never throws on malformed input — it returns a 400 instead.
 */
const crypto = require('crypto');

const MAX_ACCOUNTS = 1000;        // bound open-signup growth
const MAX_PHOTO_LEN = 400000;     // ~300KB of base64; client compresses to 150px jpeg
const NAME_MAX = 40;
const UNAME_MIN = 3, UNAME_MAX = 20;

const ACCOUNT_ACTIONS = new Set([
  'registerAccount', 'loginAccount', 'accountSession', 'updateAccount', 'logoutAccount',
]);

// Admin-console verbs. Unlike ACCOUNT_ACTIONS (public, site-code gated), these
// are dispatched only AFTER the POST endpoint has checked the admin password.
const ADMIN_ACCOUNT_ACTIONS = new Set([
  'adminListAccounts', 'adminResetPin', 'adminDeleteAccount',
]);

// ── validators (pure) ────────────────────────────────────────────────
function validateUsername(u) {
  const v = (u == null ? '' : String(u)).trim();
  if (v.length < UNAME_MIN || v.length > UNAME_MAX) {
    return { ok: false, error: `Username must be ${UNAME_MIN}–${UNAME_MAX} characters.` };
  }
  if (!/^[A-Za-z0-9_]+$/.test(v)) {
    return { ok: false, error: 'Username can only contain letters, numbers and underscores.' };
  }
  return { ok: true, value: v };
}

function validatePin(p) {
  const v = (p == null ? '' : String(p));
  if (!/^\d{6}$/.test(v)) return { ok: false, error: 'PIN must be exactly 6 digits.' };
  return { ok: true, value: v };
}

function validateName(n) {
  const v = (n == null ? '' : String(n)).trim();
  if (!v) return { ok: false, error: 'Please enter a name.' };
  if (v.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` };
  return { ok: true, value: v };
}

function validatePhoto(photo) {
  if (photo == null || photo === '') return { ok: true, value: null };
  if (typeof photo !== 'string') return { ok: false, error: 'Invalid image.' };
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(photo)) {
    return { ok: false, error: 'Invalid image.' };
  }
  if (photo.length > MAX_PHOTO_LEN) return { ok: false, error: 'Image is too large.' };
  return { ok: true, value: photo };
}

// ── lookups (pure) ───────────────────────────────────────────────────
function findByUsername(accounts, username) {
  if (!Array.isArray(accounts)) return null;
  const key = (username == null ? '' : String(username)).trim().toLowerCase();
  if (!key) return null;
  return accounts.find(a => a && String(a.username || '').toLowerCase() === key) || null;
}

function findByToken(accounts, token) {
  if (!Array.isArray(accounts) || !token) return null;
  return accounts.find(a => a && a.token && a.token === token) || null;
}

// The ONLY shape an account is ever exposed to clients in: resolves the live
// display name/photo from the roster, and deliberately omits pinHash/salt/token.
function publicAccount(account, roster) {
  const player = Array.isArray(roster) ? roster.find(r => r && r.id === account.playerId) : null;
  return {
    id: account.id,
    username: account.username,
    playerId: account.playerId,
    name: (player && player.name) || account.name || account.username,
    photo: (player && player.photo) || null,
  };
}

// Richer account view for the admin console. Like publicAccount it resolves the
// live name/photo from the roster and NEVER includes pinHash / salt / token,
// but it also surfaces points, link status, timestamps, and a hasPin flag so an
// admin can see the full picture without ever receiving a credential.
function adminAccount(account, roster) {
  const player = Array.isArray(roster) ? roster.find(r => r && r.id === account.playerId) : null;
  return {
    id: account.id,
    username: account.username,
    name: (player && player.name) || account.name || account.username,
    photo: (player && player.photo) || null,
    playerId: account.playerId || null,
    points: player ? (Number(player.points) || 0) : null,
    hasPlayer: !!player,
    hasPin: !!(account.pinHash && account.salt),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    lastLoginAt: account.lastLoginAt || null,
  };
}

// ── crypto ───────────────────────────────────────────────────────────
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 64).toString('hex');
}

function verifyPin(pin, account) {
  if (!account || !account.salt || !account.pinHash) return false;
  const a = Buffer.from(hashPin(pin, account.salt), 'hex');
  let b;
  try { b = Buffer.from(account.pinHash, 'hex'); } catch { return false; }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeId(prefix) { return prefix + crypto.randomBytes(8).toString('hex'); }

// ── GET payload guard ────────────────────────────────────────────────
// Strip the whole accounts array from any state object before it is returned to
// a client. Non-mutating — returns a shallow clone with `accounts` removed.
function redactState(state) {
  if (!state || typeof state !== 'object') return {};
  const { accounts, ...safe } = state;
  return safe;
}

// ── action handlers (mutate `state`, return {status, body, changed}) ──
function ensureArrays(state) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.roster)) state.roster = [];
}

function doRegister(state, body) {
  if (state.accounts.length >= MAX_ACCOUNTS) {
    return { status: 409, body: { error: 'Account limit reached.' }, changed: false };
  }
  const u = validateUsername(body.username);
  if (!u.ok) return { status: 400, body: { error: u.error }, changed: false };
  const pin = validatePin(body.pin);
  if (!pin.ok) return { status: 400, body: { error: pin.error }, changed: false };
  const nm = validateName(body.name);
  if (!nm.ok) return { status: 400, body: { error: nm.error }, changed: false };
  const ph = validatePhoto(body.photo);
  if (!ph.ok) return { status: 400, body: { error: ph.error }, changed: false };

  if (findByUsername(state.accounts, u.value)) {
    return { status: 409, body: { error: 'That username is taken.' }, changed: false };
  }

  const now = Date.now();
  const salt = makeSalt();
  const playerId = makeId('pa_');
  const account = {
    id: makeId('acc_'),
    username: u.value,
    salt,
    pinHash: hashPin(pin.value, salt),
    token: makeToken(),
    playerId,
    name: nm.value,           // mirror — recreation fallback if the roster row is deleted
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,         // registering signs you straight in
  };
  const player = { id: playerId, name: nm.value, photo: ph.value || null, points: 0, accountId: account.id };
  state.accounts = [...state.accounts, account];
  state.roster = [...state.roster, player];
  return { status: 200, body: { ok: true, token: account.token, account: publicAccount(account, state.roster) }, changed: true };
}

function doLogin(state, body) {
  const account = findByUsername(state.accounts, body.username);
  if (!account || !verifyPin(body.pin, account)) {
    return { status: 401, body: { error: 'Wrong username or PIN.' }, changed: false };
  }
  if (!account.token) account.token = makeToken(); // heal legacy/cleared
  account.lastLoginAt = Date.now();
  return { status: 200, body: { ok: true, token: account.token, account: publicAccount(account, state.roster) }, changed: true };
}

function doSession(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account) return { status: 401, body: { error: 'Session expired.' }, changed: false };
  return { status: 200, body: { ok: true, account: publicAccount(account, state.roster) }, changed: false };
}

function doUpdate(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account) return { status: 401, body: { error: 'Session expired.' }, changed: false };

  let nameVal;          // undefined => unchanged
  let pinVal;           // undefined => unchanged
  let photoVal;         // undefined => unchanged (null clears the photo)
  let photoProvided = false;

  if (body.name !== undefined) {
    const r = validateName(body.name);
    if (!r.ok) return { status: 400, body: { error: r.error }, changed: false };
    nameVal = r.value;
  }
  // Blank/absent PIN means "leave my PIN as-is".
  if (body.pin !== undefined && body.pin !== null && body.pin !== '') {
    const r = validatePin(body.pin);
    if (!r.ok) return { status: 400, body: { error: r.error }, changed: false };
    pinVal = r.value;
  }
  if (body.photo !== undefined) {
    const r = validatePhoto(body.photo);
    if (!r.ok) return { status: 400, body: { error: r.error }, changed: false };
    photoVal = r.value; photoProvided = true;
  }

  if (nameVal !== undefined) account.name = nameVal;
  if (pinVal !== undefined) { account.salt = makeSalt(); account.pinHash = hashPin(pinVal, account.salt); }
  account.updatedAt = Date.now();

  // Mirror name/photo onto the linked roster player so the court display updates.
  // Recreate the row if an admin has since removed it (account is source-of-truth
  // for its own identity via the cached `name`).
  let player = state.roster.find(p => p && p.id === account.playerId);
  if (!player) {
    player = { id: account.playerId, name: account.name, photo: photoProvided ? photoVal : null, points: 0, accountId: account.id };
    state.roster = [...state.roster, player];
  } else {
    if (nameVal !== undefined) player.name = nameVal;
    if (photoProvided) player.photo = photoVal;
    if (player.accountId === undefined) player.accountId = account.id;
  }
  return { status: 200, body: { ok: true, account: publicAccount(account, state.roster) }, changed: true };
}

function doLogout(state, body) {
  const account = findByToken(state.accounts, body && body.token);
  if (!account) return { status: 200, body: { ok: true }, changed: false }; // idempotent
  account.token = null;
  return { status: 200, body: { ok: true }, changed: true };
}

function handleAccountAction(state, body) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    ensureArrays(state);
    const action = body && body.action;
    switch (action) {
      case 'registerAccount': return doRegister(state, body);
      case 'loginAccount':    return doLogin(state, body);
      case 'accountSession':  return doSession(state, body);
      case 'updateAccount':   return doUpdate(state, body);
      case 'logoutAccount':   return doLogout(state, body);
      default:                return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

// ── admin-console actions (admin-password gated by the POST endpoint) ──
function doAdminList(state) {
  const accounts = state.accounts
    .map(a => adminAccount(a, state.roster))
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)); // newest first
  return { status: 200, body: { ok: true, accounts }, changed: false };
}

function doAdminResetPin(state, body) {
  const account = state.accounts.find(a => a && a.id === (body && body.id));
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  const pin = validatePin(body.pin);
  if (!pin.ok) return { status: 400, body: { error: pin.error }, changed: false };
  account.salt = makeSalt();
  account.pinHash = hashPin(pin.value, account.salt);
  account.token = null;            // revoke open sessions — they must sign in with the new PIN
  account.updatedAt = Date.now();
  return { status: 200, body: { ok: true, account: adminAccount(account, state.roster) }, changed: true };
}

function doAdminDelete(state, body) {
  const id = body && body.id;
  const account = state.accounts.find(a => a && a.id === id);
  if (!account) return { status: 404, body: { error: 'Account not found.' }, changed: false };
  state.accounts = state.accounts.filter(a => a.id !== id);
  // "Account = player": deleting the account also removes the roster player it
  // created and drops them from today's session. Historical rounds reference
  // players by id and already tolerate a missing id, so we leave them as-is.
  if (account.playerId) {
    state.roster = (state.roster || []).filter(p => !(p && p.id === account.playerId));
    if (Array.isArray(state.players)) {
      state.players = state.players.filter(p => !(p && p.id === account.playerId));
    }
  }
  return { status: 200, body: { ok: true }, changed: true };
}

function handleAdminAccountAction(state, body) {
  try {
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'Invalid request.' }, changed: false };
    ensureArrays(state);
    switch (body && body.action) {
      case 'adminListAccounts':  return doAdminList(state);
      case 'adminResetPin':      return doAdminResetPin(state, body);
      case 'adminDeleteAccount': return doAdminDelete(state, body);
      default:                   return { status: 400, body: { error: 'Unknown action.' }, changed: false };
    }
  } catch (e) {
    return { status: 400, body: { error: 'Invalid request.' }, changed: false };
  }
}

module.exports = {
  validateUsername, validatePin, validateName, validatePhoto,
  findByUsername, findByToken, publicAccount, adminAccount,
  hashPin, verifyPin, redactState,
  ACCOUNT_ACTIONS, handleAccountAction, MAX_ACCOUNTS,
  ADMIN_ACCOUNT_ACTIONS, handleAdminAccountAction,
};
