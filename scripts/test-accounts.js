#!/usr/bin/env node
/* TDD tests for the simple user-account logic (api/accounts.js).
 *
 * Accounts are open self-signup: register creates a roster player + a credential
 * record (username + salted-scrypt 6-digit PIN + session token + playerId). The
 * roster player is the canonical display name/photo; the account mirrors `name`
 * only as a recreation fallback. handleAccountAction(state, body) is the single
 * dispatch the GET-gated POST endpoint calls — it mutates `state` and reports
 * whether a persist is needed via {status, body, changed}. redactState strips
 * credentials so the GET payload can never leak a PIN hash / salt / token. */
'use strict';
const {
  validateUsername, validatePin, validateName, validatePhoto,
  findByUsername, findByToken, publicAccount, adminAccount,
  hashPin, verifyPin, redactState,
  ACCOUNT_ACTIONS, handleAccountAction, MAX_ACCOUNTS,
  ADMIN_ACCOUNT_ACTIONS, handleAdminAccountAction,
} = require('../api/accounts.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

// ── validateUsername(u) -> {ok, value?|error?} ──
check('username: valid -> ok', validateUsername('harvey').ok === true);
check('username: valid -> trimmed value', validateUsername('  harvey  ').value === 'harvey');
check('username: too short (2) -> not ok', validateUsername('ab').ok === false);
check('username: min length (3) -> ok', validateUsername('abc').ok === true);
check('username: too long (21) -> not ok', validateUsername('a'.repeat(21)).ok === false);
check('username: max length (20) -> ok', validateUsername('a'.repeat(20)).ok === true);
check('username: underscore + digits ok', validateUsername('a_1_b').ok === true);
check('username: space inside -> not ok', validateUsername('har vey').ok === false);
check('username: punctuation -> not ok', validateUsername('har.vey').ok === false);
check('username: emoji -> not ok', validateUsername('har🌸').ok === false);
check('username: number coerced to string -> ok', validateUsername(12345).ok === true);
check('username: null -> not ok (no throw)', validateUsername(null).ok === false);
check('username: undefined -> not ok (no throw)', validateUsername(undefined).ok === false);

// ── validatePin(p) -> exactly 6 digits ──
check('pin: 6 digits -> ok', validatePin('123456').ok === true);
check('pin: 6 digits -> value kept', validatePin('123456').value === '123456');
check('pin: numeric 6 digits -> ok (coerced)', validatePin(123456).ok === true);
check('pin: 5 digits -> not ok', validatePin('12345').ok === false);
check('pin: 7 digits -> not ok', validatePin('1234567').ok === false);
check('pin: letters -> not ok', validatePin('12a456').ok === false);
check('pin: empty -> not ok', validatePin('').ok === false);
check('pin: null -> not ok', validatePin(null).ok === false);
check('pin: leading zeros preserved', validatePin('001234').value === '001234');

// ── validateName(n) ──
check('name: valid -> ok', validateName('Harvey').ok === true);
check('name: trimmed', validateName('  Harvey  ').value === 'Harvey');
check('name: empty -> not ok', validateName('').ok === false);
check('name: whitespace only -> not ok', validateName('   ').ok === false);
check('name: 40 chars ok', validateName('a'.repeat(40)).ok === true);
check('name: 41 chars -> not ok', validateName('a'.repeat(41)).ok === false);
check('name: null -> not ok (no throw)', validateName(null).ok === false);

// ── validatePhoto(photo) -> null allowed, only data:image, bounded ──
check('photo: null -> ok with null value', validatePhoto(null).ok === true && validatePhoto(null).value === null);
check('photo: empty string -> ok null', validatePhoto('').ok === true && validatePhoto('').value === null);
check('photo: valid jpeg data url -> ok', validatePhoto('data:image/jpeg;base64,/9j/abc').ok === true);
check('photo: valid png data url -> ok', validatePhoto('data:image/png;base64,iVBOR').ok === true);
check('photo: non-image url -> not ok', validatePhoto('https://evil/x.png').ok === false);
check('photo: script data url -> not ok', validatePhoto('data:text/html;base64,PHN').ok === false);
check('photo: oversized -> not ok', validatePhoto('data:image/jpeg;base64,' + 'A'.repeat(500000)).ok === false);
check('photo: non-string -> not ok', validatePhoto({}).ok === false);

// ── hashPin / verifyPin (salted scrypt, constant-time) ──
{
  const salt = 'abc123';
  const h = hashPin('123456', salt);
  check('hashPin: deterministic for same pin+salt', hashPin('123456', salt) === h);
  check('hashPin: differs by salt', hashPin('123456', 'other') !== h);
  check('hashPin: differs by pin', hashPin('654321', salt) !== h);
  const acct = { salt, pinHash: h };
  check('verifyPin: correct pin -> true', verifyPin('123456', acct) === true);
  check('verifyPin: wrong pin -> false', verifyPin('000000', acct) === false);
  check('verifyPin: no salt/hash -> false (no throw)', verifyPin('123456', {}) === false);
  check('verifyPin: null account -> false (no throw)', verifyPin('123456', null) === false);
}

// ── findByUsername / findByToken (tolerant, case-insensitive username) ──
{
  const accounts = [{ id: 'a1', username: 'Harvey', token: 'tok1', playerId: 'p1' }];
  check('findByUsername: exact -> found', findByUsername(accounts, 'Harvey') === accounts[0]);
  check('findByUsername: case-insensitive -> found', findByUsername(accounts, 'HARVEY') === accounts[0]);
  check('findByUsername: trims input', findByUsername(accounts, '  harvey ') === accounts[0]);
  check('findByUsername: unknown -> null', findByUsername(accounts, 'nope') === null);
  check('findByUsername: non-array -> null (no throw)', findByUsername(null, 'harvey') === null);
  check('findByToken: match -> found', findByToken(accounts, 'tok1') === accounts[0]);
  check('findByToken: empty token -> null', findByToken(accounts, '') === null);
  check('findByToken: null token -> null', findByToken(accounts, null) === null);
  check('findByToken: unknown -> null', findByToken(accounts, 'tokX') === null);
}

// ── publicAccount resolves name/photo from the linked roster player ──
{
  const account = { id: 'a1', username: 'harvey', playerId: 'p1', name: 'StaleCache', token: 'secret', pinHash: 'h', salt: 's' };
  const roster = [{ id: 'p1', name: 'Harvey Live', photo: 'data:image/jpeg;base64,XX', points: 3 }];
  const pub = publicAccount(account, roster);
  check('publicAccount: name from roster (live)', pub.name === 'Harvey Live');
  check('publicAccount: photo from roster', pub.photo === 'data:image/jpeg;base64,XX');
  check('publicAccount: exposes id/username/playerId', pub.id === 'a1' && pub.username === 'harvey' && pub.playerId === 'p1');
  check('publicAccount: NEVER leaks pinHash/salt/token',
    pub.pinHash === undefined && pub.salt === undefined && pub.token === undefined);
  const pubOrphan = publicAccount(account, []);
  check('publicAccount: orphaned player -> falls back to account.name', pubOrphan.name === 'StaleCache');
  check('publicAccount: orphaned player -> photo null', pubOrphan.photo === null);
}

// ── redactState strips the whole accounts array from GET payloads ──
{
  const state = { roster: [{ id: 'p1', name: 'Harvey' }], accounts: [{ id: 'a1', pinHash: 'secret', salt: 'x', token: 't' }], numCourts: 2 };
  const safe = redactState(state);
  check('redactState: accounts removed', safe.accounts === undefined);
  check('redactState: roster kept', Array.isArray(safe.roster) && safe.roster.length === 1);
  check('redactState: other fields kept', safe.numCourts === 2);
  check('redactState: does not mutate input', Array.isArray(state.accounts) && state.accounts.length === 1);
  check('redactState: null input -> object (no throw)', typeof redactState(null) === 'object');
}

// ── ACCOUNT_ACTIONS set ──
check('ACCOUNT_ACTIONS: has the five actions',
  ACCOUNT_ACTIONS.has('registerAccount') && ACCOUNT_ACTIONS.has('loginAccount') &&
  ACCOUNT_ACTIONS.has('accountSession') && ACCOUNT_ACTIONS.has('updateAccount') &&
  ACCOUNT_ACTIONS.has('logoutAccount'));
check('ACCOUNT_ACTIONS: does not include submitSignup', !ACCOUNT_ACTIONS.has('submitSignup'));

const freshState = () => ({ roster: [{ id: 'p0', name: 'Thomas', photo: null, points: 0 }], accounts: [] });

// ── registerAccount: creates account + roster player, returns token ──
{
  const state = freshState();
  const r = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  check('register: status 200', r.status === 200);
  check('register: ok body', r.body.ok === true);
  check('register: returns a token', typeof r.body.token === 'string' && r.body.token.length >= 16);
  check('register: returns public account', r.body.account && r.body.account.username === 'harvey' && r.body.account.name === 'Harvey');
  check('register: NEVER returns pinHash', r.body.account.pinHash === undefined && r.body.account.token === undefined);
  check('register: changed=true', r.changed === true);
  check('register: appended one account', state.accounts.length === 1);
  check('register: created a roster player', state.roster.length === 2);
  const newPlayer = state.roster.find(p => p.id === state.accounts[0].playerId);
  check('register: roster player has the chosen name', newPlayer && newPlayer.name === 'Harvey');
  check('register: roster player links back to account', newPlayer && newPlayer.accountId === state.accounts[0].id);
  check('register: stored PIN is hashed, not plaintext', state.accounts[0].pinHash !== '123456' && !!state.accounts[0].pinHash);
  check('register: stored a salt', !!state.accounts[0].salt);
}
// register with optional photo
{
  const state = freshState();
  const r = handleAccountAction(state, { action: 'registerAccount', username: 'pic', pin: '111111', name: 'Pic', photo: 'data:image/jpeg;base64,ZZ' });
  const player = state.roster.find(p => p.id === r.body.account.playerId);
  check('register: photo stored on roster player', player && player.photo === 'data:image/jpeg;base64,ZZ');
  check('register: public account carries photo', r.body.account.photo === 'data:image/jpeg;base64,ZZ');
}
// register validation failures (no state change)
{
  const state = freshState();
  check('register: short username -> 400', handleAccountAction(state, { action: 'registerAccount', username: 'ab', pin: '123456', name: 'X' }).status === 400);
  check('register: bad pin -> 400', handleAccountAction(state, { action: 'registerAccount', username: 'okname', pin: '12', name: 'X' }).status === 400);
  check('register: empty name -> 400', handleAccountAction(state, { action: 'registerAccount', username: 'okname', pin: '123456', name: '' }).status === 400);
  check('register: bad photo -> 400', handleAccountAction(state, { action: 'registerAccount', username: 'okname', pin: '123456', name: 'X', photo: 'http://evil' }).status === 400);
  check('register: failures did not mutate state', state.accounts.length === 0 && state.roster.length === 1);
}
// duplicate username (case-insensitive) rejected
{
  const state = freshState();
  handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const dup = handleAccountAction(state, { action: 'registerAccount', username: 'HARVEY', pin: '654321', name: 'Other' });
  check('register: duplicate username -> 409', dup.status === 409);
  check('register: duplicate did not add account', state.accounts.length === 1);
}
// account cap
{
  const state = { roster: [], accounts: [] };
  for (let i = 0; i < MAX_ACCOUNTS; i++) state.accounts.push({ id: 'a' + i, username: 'u' + i, token: 't' + i, playerId: 'p' + i });
  const r = handleAccountAction(state, { action: 'registerAccount', username: 'overflow', pin: '123456', name: 'X' });
  check('register: at cap -> 409', r.status === 409);
  check('register: at cap -> no new account', state.accounts.length === MAX_ACCOUNTS);
}

// ── loginAccount: correct PIN ok, wrong PIN/unknown -> 401 ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const ok = handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '123456' });
  check('login: correct -> 200', ok.status === 200);
  check('login: returns same token (reused, not rotated)', ok.body.token === reg.body.token);
  check('login: returns public account', ok.body.account.username === 'harvey');
  check('login: case-insensitive username', handleAccountAction(state, { action: 'loginAccount', username: 'HARVEY', pin: '123456' }).status === 200);
  check('login: wrong pin -> 401', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '000000' }).status === 401);
  check('login: unknown user -> 401', handleAccountAction(state, { action: 'loginAccount', username: 'ghost', pin: '123456' }).status === 401);
  check('login: never leaks token on failure', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '000000' }).body.token === undefined);
}

// ── accountSession: validate a stored token, restore session ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const token = reg.body.token;
  const ses = handleAccountAction(state, { action: 'accountSession', token });
  check('session: valid token -> 200', ses.status === 200);
  check('session: returns the account', ses.body.account.username === 'harvey');
  check('session: read-only -> changed=false', ses.changed === false);
  check('session: bad token -> 401', handleAccountAction(state, { action: 'accountSession', token: 'nope' }).status === 401);
  check('session: missing token -> 401', handleAccountAction(state, { action: 'accountSession' }).status === 401);
}

// ── updateAccount: change name / pin / photo via token ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const token = reg.body.token;
  const playerId = reg.body.account.playerId;

  const renamed = handleAccountAction(state, { action: 'updateAccount', token, name: 'Harv' });
  check('update: name change -> 200', renamed.status === 200);
  check('update: public account reflects new name', renamed.body.account.name === 'Harv');
  check('update: roster player renamed (flows to court display)', state.roster.find(p => p.id === playerId).name === 'Harv');
  check('update: changed=true', renamed.changed === true);

  const photoed = handleAccountAction(state, { action: 'updateAccount', token, photo: 'data:image/png;base64,QRS' });
  check('update: photo set on roster player', state.roster.find(p => p.id === playerId).photo === 'data:image/png;base64,QRS');

  // change PIN, then old PIN must fail and new PIN must work
  const pinChanged = handleAccountAction(state, { action: 'updateAccount', token, pin: '999999' });
  check('update: pin change -> 200', pinChanged.status === 200);
  check('update: old pin no longer works', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '123456' }).status === 401);
  check('update: new pin works', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '999999' }).status === 200);

  // blank pin means "leave PIN unchanged"
  const blankPin = handleAccountAction(state, { action: 'updateAccount', token, pin: '' });
  check('update: blank pin tolerated -> 200', blankPin.status === 200);
  check('update: blank pin kept new pin', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '999999' }).status === 200);

  check('update: bad token -> 401', handleAccountAction(state, { action: 'updateAccount', token: 'nope', name: 'X' }).status === 401);
  check('update: invalid new name -> 400', handleAccountAction(state, { action: 'updateAccount', token, name: '' }).status === 400);
  check('update: invalid new pin -> 400', handleAccountAction(state, { action: 'updateAccount', token, pin: '12' }).status === 400);
  check('update: invalid photo -> 400', handleAccountAction(state, { action: 'updateAccount', token, photo: 'http://evil' }).status === 400);
}
// update recreates the roster player if an admin deleted it
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const token = reg.body.token;
  const playerId = reg.body.account.playerId;
  state.roster = state.roster.filter(p => p.id !== playerId); // admin removed the player
  const r = handleAccountAction(state, { action: 'updateAccount', token, name: 'Reborn' });
  check('update: orphaned account -> 200', r.status === 200);
  const recreated = state.roster.find(p => p.id === playerId);
  check('update: roster player recreated', !!recreated && recreated.name === 'Reborn');
}

// ── logoutAccount: invalidate token ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const token = reg.body.token;
  const out = handleAccountAction(state, { action: 'logoutAccount', token });
  check('logout: -> 200 ok', out.status === 200 && out.body.ok === true);
  check('logout: changed=true', out.changed === true);
  check('logout: token no longer valid for session', handleAccountAction(state, { action: 'accountSession', token }).status === 401);
  check('logout: idempotent on unknown token -> 200, changed=false',
    handleAccountAction(state, { action: 'logoutAccount', token: 'nope' }).changed === false);
  check('logout: login still works after logout (creates fresh token)',
    handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '123456' }).status === 200);
}

// ── robustness: garbage never throws ──
check('handleAccountAction: null body -> safe 400-ish (no throw)', [400, 401].indexOf(handleAccountAction(freshState(), null).status) !== -1);
check('handleAccountAction: unknown action -> 400', handleAccountAction(freshState(), { action: 'whoami' }).status === 400);
{
  const noArrays = {};
  const r = handleAccountAction(noArrays, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  check('handleAccountAction: tolerates state without arrays', r.status === 200 && Array.isArray(noArrays.accounts) && Array.isArray(noArrays.roster));
}

// ── lastLoginAt: stamped on register + login, NOT on a session check ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  check('lastLogin: stamped at register', typeof state.accounts[0].lastLoginAt === 'number' && state.accounts[0].lastLoginAt > 0);
  state.accounts[0].lastLoginAt = 1; // force a low value so a real login must bump it
  const log = handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '123456' });
  check('lastLogin: bumped on login', state.accounts[0].lastLoginAt > 1);
  check('lastLogin: login persists (changed=true)', log.changed === true);
  const stamp = state.accounts[0].lastLoginAt;
  handleAccountAction(state, { action: 'accountSession', token: reg.body.token });
  check('lastLogin: session check does NOT bump it (no write storm)', state.accounts[0].lastLoginAt === stamp);
}

// ── ADMIN_ACCOUNT_ACTIONS: distinct from the public set ──
check('ADMIN_ACCOUNT_ACTIONS: has list/resetPin/delete',
  ADMIN_ACCOUNT_ACTIONS.has('adminListAccounts') && ADMIN_ACCOUNT_ACTIONS.has('adminResetPin') && ADMIN_ACCOUNT_ACTIONS.has('adminDeleteAccount'));
check('ADMIN_ACCOUNT_ACTIONS: does not overlap public ACCOUNT_ACTIONS',
  !ADMIN_ACCOUNT_ACTIONS.has('registerAccount') && !ACCOUNT_ACTIONS.has('adminListAccounts'));

// ── adminAccount: rich admin view, still NO secrets ──
{
  const account = { id: 'a1', username: 'harvey', playerId: 'p1', name: 'Cache', token: 'secret', pinHash: 'h', salt: 's', createdAt: 10, updatedAt: 20, lastLoginAt: 30 };
  const roster = [{ id: 'p1', name: 'Harvey Live', photo: 'data:image/jpeg;base64,XX', points: 7 }];
  const a = adminAccount(account, roster);
  check('adminAccount: id + username', a.id === 'a1' && a.username === 'harvey');
  check('adminAccount: live name + photo from roster', a.name === 'Harvey Live' && a.photo === 'data:image/jpeg;base64,XX');
  check('adminAccount: points + hasPlayer from roster', a.points === 7 && a.hasPlayer === true);
  check('adminAccount: hasPin true when hash present', a.hasPin === true);
  check('adminAccount: timestamps surfaced', a.createdAt === 10 && a.updatedAt === 20 && a.lastLoginAt === 30);
  check('adminAccount: NEVER leaks pinHash/salt/token', a.pinHash === undefined && a.salt === undefined && a.token === undefined);
  const orphan = adminAccount(account, []);
  check('adminAccount: orphaned -> hasPlayer false, points null, name from cache',
    orphan.hasPlayer === false && orphan.points === null && orphan.name === 'Cache');
}

// ── adminListAccounts: lists all, newest first, no secrets ──
{
  const state = freshState();
  handleAccountAction(state, { action: 'registerAccount', username: 'aaa', pin: '111111', name: 'Aaa' });
  handleAccountAction(state, { action: 'registerAccount', username: 'bbb', pin: '222222', name: 'Bbb' });
  const r = handleAdminAccountAction(state, { action: 'adminListAccounts' });
  check('adminList: 200 + ok', r.status === 200 && r.body.ok === true);
  check('adminList: returns every account', Array.isArray(r.body.accounts) && r.body.accounts.length === 2);
  check('adminList: read-only (changed=false)', r.changed === false);
  check('adminList: items carry no secrets', r.body.accounts.every(a => a.pinHash === undefined && a.salt === undefined && a.token === undefined));
  check('adminList: items carry username + createdAt', r.body.accounts.every(a => typeof a.username === 'string' && typeof a.createdAt === 'number'));
}

// ── adminResetPin: sets a new PIN, revokes the old session ──
{
  const state = freshState();
  const reg = handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const id = state.accounts[0].id;
  const oldToken = reg.body.token;
  const r = handleAdminAccountAction(state, { action: 'adminResetPin', id, pin: '777777' });
  check('adminResetPin: 200 + changed', r.status === 200 && r.changed === true);
  check('adminResetPin: revokes existing session token', handleAccountAction(state, { action: 'accountSession', token: oldToken }).status === 401);
  check('adminResetPin: old PIN no longer works', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '123456' }).status === 401);
  check('adminResetPin: new PIN works', handleAccountAction(state, { action: 'loginAccount', username: 'harvey', pin: '777777' }).status === 200);
  check('adminResetPin: response carries no secrets', r.body.account && r.body.account.pinHash === undefined && r.body.account.salt === undefined && r.body.account.token === undefined);
  check('adminResetPin: bad PIN -> 400', handleAdminAccountAction(state, { action: 'adminResetPin', id, pin: '12' }).status === 400);
  check('adminResetPin: unknown id -> 404', handleAdminAccountAction(state, { action: 'adminResetPin', id: 'nope', pin: '777777' }).status === 404);
}

// ── adminDeleteAccount: removes account + linked player + today's slot ──
{
  const state = freshState();
  handleAccountAction(state, { action: 'registerAccount', username: 'harvey', pin: '123456', name: 'Harvey' });
  const id = state.accounts[0].id;
  const playerId = state.accounts[0].playerId;
  state.players = [{ id: playerId, name: 'Harvey' }, { id: 'p0', name: 'Thomas' }];
  const r = handleAdminAccountAction(state, { action: 'adminDeleteAccount', id });
  check('adminDelete: 200 + changed', r.status === 200 && r.changed === true);
  check('adminDelete: account removed', state.accounts.length === 0);
  check('adminDelete: linked roster player removed', !state.roster.some(p => p.id === playerId));
  check('adminDelete: dropped from today\'s players', !state.players.some(p => p.id === playerId));
  check('adminDelete: other players untouched', state.players.some(p => p.id === 'p0'));
  check('adminDelete: unknown id -> 404', handleAdminAccountAction(state, { action: 'adminDeleteAccount', id: 'nope' }).status === 404);
}

// ── admin dispatch robustness: garbage never throws ──
check('handleAdminAccountAction: unknown action -> 400', handleAdminAccountAction(freshState(), { action: 'whatever' }).status === 400);
check('handleAdminAccountAction: null body -> 400 (no throw)', handleAdminAccountAction(freshState(), null).status === 400);

console.log(`\naccount tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
