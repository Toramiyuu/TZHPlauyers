const { Redis } = require('@upstash/redis');
const { ACCOUNT_ACTIONS, handleAccountAction, redactState, ADMIN_ACCOUNT_ACTIONS, handleAdminAccountAction, playerPhoneMap } = require('../lib/accounts.js');
const { handleMemberInfo } = require('../lib/member.js');
const { WEEKLY_ADMIN_ACTIONS, handleWeeklyAdminAction, pruneWeeklyState } = require('../lib/weekly.js');
const { SESSION_DRAW_ADMIN_ACTIONS, handleSessionDrawAdminAction, sweepSessionDraws, redisDrawStore } = require('../lib/session-draw.js');
const SD = require('../public/session-draw.js');
const { MONTHLY_LUCKY_ADMIN_ACTIONS, handleMonthlyLuckyAdminAction, sweepMonthlyDraws, buildMonthlyView, redisMonthlyStore, applyMonthClose } = require('../lib/monthly-lucky.js');
const ML = require('../public/monthly-lucky.js');
const { PAYMENT_ADMIN_ACTIONS, handlePaymentAdminAction } = require('../lib/payments.js');
const { pushAudit } = require('../lib/audit.js');
const Payments = require('../public/payments.js');
const AdminNav = require('../public/admin-nav.js');
const Night = require('../public/night.js');

// Accepts env vars from Vercel Marketplace (KV_REST_API_URL) or direct Upstash (UPSTASH_REDIS_REST_URL)
let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) {
  console.warn('Redis init skipped:', e.message);
}

const kv = {
  get: async (key) => redis ? redis.get(key) : null,
  set: async (key, val) => {
    if (!redis) throw new Error('No Redis configured');
    return redis.set(key, val);
  },
  // Hash ops for the permanent draw-result store (lib/session-draw.js). HSETNX
  // is what makes a draw impossible to write twice, even across racing callers.
  hget: async (key, field) => redis ? redis.hget(key, field) : null,
  hgetall: async (key) => redis ? redis.hgetall(key) : null,
  hsetnx: async (key, field, val) => {
    if (!redis) throw new Error('No Redis configured');
    return redis.hsetnx(key, field, val);
  },
  // Only the admin "Remove result" path (and the re-run that follows it) writes
  // over an existing field — see lib/session-draw.js.
  hset: async (key, field, val) => {
    if (!redis) throw new Error('No Redis configured');
    return redis.hset(key, { [field]: val });
  },
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';
// A demo/sandbox deployment can point the whole app at a throwaway set of keys
// (TZH_KEY_PREFIX=demo-) so it can never read or write the live data.
const KEY_PREFIX = process.env.TZH_KEY_PREFIX || '';
const STATE_KEY = KEY_PREFIX + 'court-state';
// Session draw results: a separate Redis hash (`court-draws`, field = ISO date),
// never pruned, never rewritten — see lib/session-draw.js.
const drawStore = redisDrawStore(kv);
// Monthly (points-based) draw results: a second permanent hash (`court-monthly-draws`,
// field = YYYY-MM) — see lib/monthly-lucky.js.
const monthlyStore = redisMonthlyStore(kv);

// Local "today" for the club. Vercel runs in UTC, so without an offset the
// date flips at the wrong moment for non-UTC users (B8). Defaults to UTC+8.
function todayISO() {
  const offsetHours = parseFloat(process.env.TZ_OFFSET_HOURS || '8');
  const d = new Date(Date.now() + offsetHours * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_ROSTER = [
  { id: 'p0',  name: 'Thomas',     photo: null, points: 0 },
  { id: 'p1',  name: 'Desmond',    photo: null, points: 0 },
  { id: 'p2',  name: 'Celine 🌸',  photo: null, points: 0 },
  { id: 'p3',  name: 'Sharmin',    photo: null, points: 0 },
  { id: 'p4',  name: 'Terence',    photo: null, points: 0 },
  { id: 'p5',  name: 'Alex',       photo: null, points: 0 },
  { id: 'p6',  name: 'Kokyan',     photo: null, points: 0 },
  { id: 'p7',  name: 'Yit Fung',   photo: null, points: 0 },
  { id: 'p8',  name: 'Ong Yi',     photo: null, points: 0 },
  { id: 'p9',  name: 'Shane',      photo: null, points: 0 },
  { id: 'p10', name: 'Kenn',        photo: null, points: 0 },
  { id: 'p11', name: 'Boon Chuan', photo: null, points: 0 },
  { id: 'p12', name: 'Seng',       photo: null, points: 0 },
  { id: 'p13', name: 'Gp',         photo: null, points: 0 },
  { id: 'p14', name: 'Wei Hao',    photo: null, points: 0 },
  { id: 'p15', name: 'Yao',        photo: null, points: 0 },
  { id: 'p16', name: 'uncle Tan',  photo: null, points: 0 },
  { id: 'p17', name: 'jian',       photo: null, points: 0 },
  { id: 'p18', name: 'dean',       photo: null, points: 0 },
];

const DEFAULT_STATE = {
  roster: DEFAULT_ROSTER,
  players: [],
  numCourts: 2,
  courtNumbers: [1, 2],
  rounds: [],
  currentRound: 0,
  endingSoon: [],
  sessionDate: todayISO(),
  sessions: {},
  // Session fee tier for the live day ('2h' = RM20, '3h' = RM25). Snapshotted with the
  // session; "End of the day" (lib/payments.js) generates payment records at this tier.
  feeTier: Payments.DEFAULT_TIER,
  luckyDraw: { entries: [], paid: [], drawDate: todayISO(), spin: null, results: [], history: [] },
  socialGames: [
    { id: 'sg-fri', day: 'Friday', weekday: 5, time: '9–11pm', enabled: true },
    { id: 'sg-sun', day: 'Sunday', weekday: 0, time: '9–11pm', enabled: true },
    { id: 'sg-mon', day: 'Monday', weekday: 1, time: '9–11pm', enabled: true },
  ],
  signups: [],
  // Weekly regulars: weekday (0=Sun..6=Sat) -> array of roster ids who always
  // come that day. Admins set this in Settings; the admin Session tab surfaces a
  // one-tap "Add regulars" prompt when the session date lands on a matching day.
  regulars: {},
  // Which admin tabs sit in the PHONE bottom bar (Settings → Phone shortcuts).
  // Shared by every admin device; the rest are reachable via "More".
  adminShortcuts: AdminNav.DEFAULT_SHORTCUTS.slice(),
  // ── attendance/payment (2026-07 overhaul) ──
  // Durable per-session attendance/payment records, keyed by ISO date. Separate
  // from `sessions` (which prunes at 31 days) so Monthly aggregation can look
  // back across a whole month. entries: { playerId: {playerId,name,present,paid,source,payment} }.
  attendance: {},
  // ── automatic per-session Lucky Draw (2026-09) ──
  // Winners per draw (admin-configurable). The schedule itself is a fixed table in
  // public/session-draw.js; results live in the separate `court-draws` Redis hash.
  drawSettings: { winners: SD.DEFAULT_WINNERS, prize: '', prizes: [] },
  // Scheduled draw instant (epoch ms) for the LIVE session day, stamped when the
  // day is created (applySessionDateChange); null on days that never draw.
  sessionDrawAt: SD.scheduledDrawAt(todayISO()),
  // ── points-based Monthly Lucky Draw (2026-09) ──
  // Settings + the month the roster points belong to + the pulled pool + closed-month
  // snapshots. Written ONLY through the monthly draw actions (lib/monthly-lucky.js);
  // results live in the separate `court-monthly-draws` Redis hash.
  monthlyLucky: { auto: true, winners: ML.DEFAULT_WINNERS, threshold: ML.DEFAULT_THRESHOLD, prizes: [], pointsMonth: ML.monthKeyOf(todayISO()), pool: null, closed: {} },
  // Permanent { playerId: total } ledger of every point ever earned. Survives
  // the month-close reset and never leaves the server without the admin
  // password (see ensureLifetimePoints / adminGetOps).
  lifetimePoints: {},
  // Durable admin audit log (bounded).
  audit: [],
};


// Full public GET projection: redactState() already strips the accounts array;
// on top of that we strip attendance and audit (both contain other players'
// private attendance/payment data).
// `weeklyDraws` / `weeklySettings` (retired Weekly draw) and `monthlyDraw` /
// `monthlyEligibility` (the Shuttlecock ballot, removed 2026-09) are legacy keys.
// An existing blob is NOT rewritten to drop them — the records are simply left
// dormant — so they are stripped here to keep old per-player name lists from
// leaking and off the 2s poll.
// Session draw results are served by GET /api/draws (site-code gated), not here.
function publicProjection(current) {
  const { attendance, audit, monthlyDraw, monthlyEligibility, weeklyDraws, weeklySettings, ...safe } = redactState(current);
  return liteMonthlyLucky(safe);
}
// Both polls (public GET + admin auth ping) carry only the LIGHT monthly-draw
// settings: prize photos and the closed-month point snapshots are bulky and are
// served by GET /api/draws (players) and the getMonthlyDraws action (admin).
// Neither poll carries `lifetimePoints`: it is admin-only, and stripping it in
// ONE place means there is exactly one source for it on the client (the
// adminGetOps ops cache) rather than a field that appears and vanishes every 2s.
function liteMonthlyLucky(s) {
  const { lifetimePoints, ...rest } = s || {};
  // Session prize photos are just as bulky as the monthly ones: the poll carries
  // the list (names/places, so the viewer can say what is on offer) without them.
  const draw = rest.drawSettings || {};
  return Object.assign({}, rest, {
    monthlyLucky: ML.liteOf(s && s.monthlyLucky, todayISO()),
    drawSettings: Object.assign({}, draw, { prizes: SD.litePrizes(draw.prizes) }),
  });
}

// Gracefully migrate the luckyDraw sub-object of an arbitrary (possibly old)
// saved blob to the 2026-06-28 draw-overhaul shape. Additive and tolerant — never
// throws on malformed input; the legacy luckyDraw.lastWinner field is simply ignored.
function normalizeDrawState(current) {
  current = current || {};

  if (!current.luckyDraw || typeof current.luckyDraw !== 'object') {
    current.luckyDraw = { entries: [], drawDate: todayISO(), spin: null, results: [], history: [] };
  }
  {
    const ld = current.luckyDraw;
    if (!Array.isArray(ld.entries)) ld.entries = [];
    if (typeof ld.drawDate !== 'string' || !ld.drawDate) ld.drawDate = todayISO();
    if (!Array.isArray(ld.results)) ld.results = [];
    if (!Array.isArray(ld.history)) ld.history = [];
    if (ld.spin === undefined) ld.spin = null;
    // Paid-player pool: ensure the array exists and drop entries past their
    // 2-day window on every read, so expired paid players never resurface.
    if (!Array.isArray(ld.paid)) ld.paid = [];
    ld.paid = pruneExpiredPaid(ld.paid, todayISO());
    // legacy `lastWinner` (if present) is intentionally ignored
  }

  return current;
}

// ── Calendar join-flow validation ────────────────────────────────────
// Mirrors public/monthly-draw.js. Inlined (not require('../public/...')) to
// avoid Vercel function-bundling path surprises — keep the two copies in sync;
// the logic is covered by scripts/test-signups.js (which tests both copies).
const SKILLS = ['Beginner', 'Intermediate', 'Advanced'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidISO(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
function isoWeekday(iso) {
  const m = ISO_RE.exec(String(iso));
  if (!m) return -1;
  return new Date(+m[1], +m[2] - 1, +m[3]).getDay();
}
function weekdayName(iso) {
  const w = isoWeekday(iso);
  return w >= 0 ? WEEKDAY_NAMES[w] : '';
}
function addMonthsISO(iso, n) {
  const m = ISO_RE.exec(String(iso));
  if (!m) return String(iso);
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const total = y * 12 + mo + Math.trunc(Number(n) || 0);
  const ny = Math.floor(total / 12);
  const nmo = ((total % 12) + 12) % 12;
  const lastDay = new Date(ny, nmo + 1, 0).getDate();
  const nd = Math.min(d, lastDay);
  return ny + '-' + String(nmo + 1).padStart(2, '0') + '-' + String(nd).padStart(2, '0');
}

function addDaysISO(iso, n) {
  const m = ISO_RE.exec(String(iso));
  if (!m) return String(iso);
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCDate(dt.getUTCDate() + (Math.trunc(Number(n) || 0)));
  return dt.toISOString().slice(0, 10);
}

// Points earned by each player who took part in a session, credited once when
// that day is closed (see awardSessionPoints / applySessionDateChange).
const POINTS_PER_SESSION = 2;

// ── LIFETIME POINTS (admin-only) ─────────────────────────────────────────────
// Monthly points are wiped for EVERYONE at month close — whether or not they
// reached the threshold, whether or not they won (ML.closeIfDue). That reset is
// the Monthly draw's whole premise, so the running total of what a player has
// ever earned has to live somewhere the reset can't reach: `state.lifetimePoints`,
// a plain { playerId: total } map that closeIfDue never touches.
//
// It is deliberately NOT a field on the roster entries. The admin client posts
// its WHOLE roster copy back for name/level/photo/girl/mixed edits, so a stale
// copy would silently rewrite every total on the next tap. Kept apart, it can
// only ever change through the two places points are actually credited
// (awardSessionPoints and the setRosterPoints action).
//
// It is also never in the public GET (see liteMonthlyLucky) — an authenticated
// admin fetches it with the rest of the private ops data via adminGetOps.
const MAX_LIFETIME_POINTS = 10000000;

function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** One player's lifetime total, 0 for anything missing or junk. Pure. */
function lifetimeOf(map, playerId) {
  const n = isPlainMap(map) ? Number(map[playerId]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(Math.min(n, MAX_LIFETIME_POINTS)) : 0;
}

/**
 * Apply a signed change to one player's lifetime total. Returns a NEW map
 * clamped into 0..MAX_LIFETIME_POINTS and never mutates the one it is given; a
 * zero/junk delta or a missing id returns the map untouched, so callers can
 * assign the result unconditionally. Pure.
 */
function addLifetimePoints(map, playerId, delta) {
  const base = isPlainMap(map) ? map : {};
  const id = String(playerId == null ? '' : playerId);
  // Only a number or a numeric string counts — Number(true) is 1 and Number([])
  // is 0, so coercing whatever arrives would let junk move a permanent total.
  const d = Math.trunc((typeof delta === 'number' || typeof delta === 'string') ? Number(delta) : NaN);
  if (!id || !Number.isFinite(d) || d === 0) return base;
  const next = Math.max(0, Math.min(MAX_LIFETIME_POINTS, lifetimeOf(base, id) + d));
  return Object.assign({}, base, { [id]: next });
}

/**
 * Make sure the blob HAS a lifetime map, in place. An existing map is only
 * coerced (junk values -> 0), never re-seeded, so real totals can't be
 * overwritten by a later read. A blob that has never seen this feature is
 * seeded with everything still on record: what each roster player holds right
 * now PLUS every closed-month snapshot we still keep. Those two are disjoint —
 * a month's points are snapshotted and only then zeroed — so nothing is
 * double-counted. Returns the map.
 */
function ensureLifetimePoints(state) {
  if (!state || typeof state !== 'object') return {};
  if (isPlainMap(state.lifetimePoints)) {
    const clean = {};
    for (const id of Object.keys(state.lifetimePoints)) clean[id] = lifetimeOf(state.lifetimePoints, id);
    state.lifetimePoints = clean;
    return clean;
  }
  const seeded = {};
  const bump = (id, n) => {
    if (!id) return;
    seeded[id] = Math.max(0, Math.min(MAX_LIFETIME_POINTS, (seeded[id] || 0) + (Math.trunc(Number(n)) || 0)));
  };
  for (const r of (Array.isArray(state.roster) ? state.roster : [])) if (r && r.id) bump(r.id, r.points);
  const closed = (state.monthlyLucky && isPlainMap(state.monthlyLucky.closed)) ? state.monthlyLucky.closed : {};
  for (const m of Object.keys(closed)) {
    const pts = (closed[m] && isPlainMap(closed[m].points)) ? closed[m].points : {};
    for (const id of Object.keys(pts)) bump(id, pts[id]);
  }
  state.lifetimePoints = seeded;
  return seeded;
}

/**
 * Credit POINTS_PER_SESSION to every roster player who appears in the outgoing
 * day's `players`, ONCE per session date. The same +2 also lands on their
 * permanent lifetime total. Returns { roster, awardedSessions, lifetimePoints }
 * with fresh values only when an award actually happens; otherwise returns the
 * originals untouched (so callers can assign unconditionally without breaking
 * purity). Guests (in players, not in roster) earn nothing. Pure.
 */
function awardSessionPoints(state, leavingDate) {
  const roster = state.roster || [];
  const awarded = Array.isArray(state.awardedSessions) ? state.awardedSessions : [];
  const unchanged = { roster: state.roster, awardedSessions: state.awardedSessions, lifetimePoints: state.lifetimePoints };
  if (!leavingDate || awarded.includes(leavingDate)) return unchanged;
  const playedIds = new Set((state.players || []).map((p) => p.id));
  const anyPlayed = roster.some((r) => playedIds.has(r.id));
  if (!anyPlayed) return unchanged;
  let lifetime = isPlainMap(state.lifetimePoints) ? state.lifetimePoints : {};
  roster.forEach((r) => { if (r && r.id && playedIds.has(r.id)) lifetime = addLifetimePoints(lifetime, r.id, POINTS_PER_SESSION); });
  return {
    roster: roster.map((r) =>
      playedIds.has(r.id) ? Object.assign({}, r, { points: (r.points || 0) + POINTS_PER_SESSION }) : r
    ),
    awardedSessions: awarded.concat([leavingDate]),
    lifetimePoints: lifetime,
  };
}

// ── WEEKLY REGULARS ──────────────────────────────────────────────────────────
// Given the regulars map (weekday -> ids), a weekday (0=Sun..6=Sat), the ids
// ── ROSTER BULK ADD ──────────────────────────────────────────────────────────
// Caps for the permanent roster and for one paste into "Add Multiple".
const MAX_ROSTER = 300;
const MAX_BULK_ADD = 100;
const MAX_ROSTER_NAME = 40;

/**
 * Build the roster entries for a bulk add. Pure — the caller passes the current
 * roster and a clock and gets back either an error or the new player objects.
 *
 * The client used to POST the ENTIRE roster back (every base64 photo included)
 * just to append a few names. That made a read-modify-write which raced the 2s
 * poll, grew with the squad, and — because the old confirmBulkImport never read
 * the response — failed completely silently behind a green success toast. The
 * client now sends only the names and the server appends to its own fresh copy.
 */
function buildRosterAdditions(roster, names, nowMs) {
  if (!Array.isArray(names)) return { ok: false, error: 'No names supplied.' };
  const clean = names
    .map((n) => String(n == null ? '' : n).trim().replace(/\s+/g, ' ').slice(0, MAX_ROSTER_NAME))
    .filter((n) => n.length > 0);
  if (!clean.length) return { ok: false, error: 'No names entered.' };
  if (clean.length > MAX_BULK_ADD) {
    return { ok: false, error: 'Add at most ' + MAX_BULK_ADD + ' players at a time.' };
  }
  const existing = Array.isArray(roster) ? roster : [];
  if (existing.length + clean.length > MAX_ROSTER) {
    return { ok: false, error: 'The roster holds at most ' + MAX_ROSTER + ' players — that would make ' + (existing.length + clean.length) + '.' };
  }
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  // id = timestamp + row index + entropy, so a whole paste can never self-collide
  // and two admins pasting in the same millisecond still get distinct ids.
  const players = clean.map((name, i) => ({
    id: 'r' + at.toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    photo: null,
    points: 0,
  }));
  return { ok: true, players };
}

// Manual points edit. Points drive Monthly-draw eligibility and are wiped at
// month close, so an organiser override is validated here and written to the
// audit log rather than riding the generic roster merge. Pure: returns the new
// roster (or an error) and never mutates the one it is given.
const MAX_POINTS = 100000;

function isPointsValue(n) {
  return Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
}

/**
 * `points` sets the total outright; `delta` adjusts the current total (the +/-
 * buttons). Exactly one of them must be supplied. The result is always clamped
 * into 0..MAX_POINTS so a stepper can never drive a player negative.
 */
function buildRosterPointsUpdate(roster, playerId, body) {
  const list = Array.isArray(roster) ? roster : [];
  const idx = list.findIndex((r) => r && r.id === playerId);
  if (idx === -1) return { ok: false, error: 'That player is not on the roster.' };

  const hasPoints = body && body.points !== undefined && body.points !== null && body.points !== '';
  const hasDelta = body && body.delta !== undefined && body.delta !== null && body.delta !== '';
  if (hasPoints === hasDelta) return { ok: false, error: 'Send either points or delta.' };

  const prev = Number.isInteger(list[idx].points) ? list[idx].points : 0;
  // Only a number or a numeric string counts. Number(true) is 1 and Number([])
  // is 0, so coercing whatever arrives would let junk set a real total.
  const numeric = (v) => (typeof v === 'number' || typeof v === 'string') ? Number(v) : NaN;

  let next;
  if (hasPoints) {
    next = numeric(body.points);
    if (!isPointsValue(next)) {
      return { ok: false, error: 'Points must be a whole number from 0 to ' + MAX_POINTS + '.' };
    }
  } else {
    const d = numeric(body.delta);
    if (!Number.isInteger(d) || Math.abs(d) > MAX_POINTS) return { ok: false, error: 'Invalid points change.' };
    next = Math.max(0, Math.min(MAX_POINTS, prev + d));
  }

  const player = Object.assign({}, list[idx], { points: next });
  const updated = list.slice();
  updated[idx] = player;
  return { ok: true, roster: updated, player, prev, next };
}

// already in today's session, and the ids currently on the roster, return the
// roster ids that should be offered by the admin's one-tap "Add regulars" button:
// regulars for that day who still exist on the roster and aren't already playing.
// Order-preserving, de-duped, and tolerant of number OR string weekday keys
// (JS coerces regulars[1] === regulars["1"]). Pure — never mutates its inputs.
function regularsToAdd(regulars, weekday, sessionIds, rosterIds) {
  const map = (regulars && typeof regulars === 'object') ? regulars : {};
  const ids = Array.isArray(map[weekday]) ? map[weekday] : [];
  const inSession = new Set(sessionIds || []);
  const onRoster = new Set(rosterIds || []);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!onRoster.has(id) || inSession.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Session-player objects ({id,name}) for the weekly regulars of the weekday that
// `iso` falls on — used to auto-populate a fresh session when its date is set to a
// day the admin has regulars for. Resolves names against the current roster and
// skips ids no longer on it. Pure — never mutates its inputs.
function seedRegularPlayers(state, iso) {
  state = state || {};
  const roster = state.roster || [];
  const byId = new Map(roster.map((r) => [r.id, r]));
  const ids = regularsToAdd(state.regulars, isoWeekday(iso), [], [...byId.keys()]);
  return ids.map((id) => { const r = byId.get(id); return { id: r.id, name: r.name }; });
}

// ── LUCKY DRAW: paid-player entries with a 2-day window ──────────────────────
// A player ticked as "paid" for a session stays in the draw pool until 2 days
// after that session date (Mon→Wed, Fri→Sun, Sun→Tue), then auto-prunes. Kept
// while today <= sessionDate + 2 (last day inclusive). Pure.
function paidEntryExpiry(forDate) { return addDaysISO(forDate, 2); }
function pruneExpiredPaid(paid, today) {
  if (!Array.isArray(paid)) return [];
  return paid.filter((p) => p && p.forDate && today <= addDaysISO(p.forDate, 2));
}

/**
 * Apply a session-date change, returning { ok:true, state } or { ok:false, error }.
 * Pure — never mutates the passed state. Shared by the api/state.js handler and
 * server.js so local dev and production can't drift (that drift is what let the
 * "go to a next day" bug slip through local testing).
 *
 *  - Allows dates up to ONE MONTH ahead (matches the admin UI's maxSessionDateISO,
 *    so scheduling the next session day works instead of 400'ing).
 *  - Snapshots the outgoing day into state.sessions and prunes entries >31 days old.
 *  - RESTORES the target day's saved session if one exists (so revisiting a day
 *    brings its players/rounds/courts back instead of showing an empty day);
 *    otherwise starts the day fresh while keeping numCourts + courtNumbers.
 *  - Stamps the scheduled Lucky Draw time: `drawAt` on the outgoing snapshot and
 *    `sessionDrawAt` for the new live day (null when that weekday never draws).
 */
function applySessionDateChange(state, newDate, today) {
  state = state || {};
  today = today || todayISO();
  if (newDate > addMonthsISO(today, 1)) {
    return { ok: false, error: 'Cannot set a date more than a month ahead.' };
  }
  const next = Object.assign({}, state);
  if (newDate !== state.sessionDate && state.sessionDate) {
    // Closing the outgoing day: credit +2 to everyone who played it (once).
    const award = awardSessionPoints(state, state.sessionDate);
    next.roster = award.roster;
    if (award.awardedSessions !== undefined) next.awardedSessions = award.awardedSessions;
    if (award.lifetimePoints !== undefined) next.lifetimePoints = award.lifetimePoints;
    const snapshot = {
      players: (state.players || []).map((p) => ({ id: p.id, name: p.name })),
      rounds: state.rounds || [],
      numCourts: state.numCourts || 1,
      courtNumbers: state.courtNumbers || [],
      courtRounds: state.courtRounds || [],
      feeTier: Payments.tierOf(state.feeTier),
      drawAt: SD.scheduledDrawAt(state.sessionDate),
    };
    const sessions = Object.assign({}, state.sessions, { [state.sessionDate]: snapshot });
    const cutoffStr = addDaysISO(today, -31);
    for (const d of Object.keys(sessions)) {
      if (d < cutoffStr) delete sessions[d];
    }
    const saved = sessions[newDate];
    if (saved) {
      // Revisiting a saved day — bring its data back to life.
      next.players = Array.isArray(saved.players) ? saved.players : [];
      next.rounds = Array.isArray(saved.rounds) ? saved.rounds : [];
      next.numCourts = saved.numCourts || state.numCourts || 1;
      next.courtNumbers = Array.isArray(saved.courtNumbers) ? saved.courtNumbers : [];
      next.courtRounds = Array.isArray(saved.courtRounds) ? saved.courtRounds : [];
      next.feeTier = Payments.tierOf(saved.feeTier);
      delete sessions[newDate]; // it's the live day now, not a saved past day
    } else {
      // Fresh day — start empty but auto-add the weekly regulars for this
      // weekday (Harvey always comes Monday, etc.). Keeps the venue's court setup.
      next.players = seedRegularPlayers(state, newDate);
      next.rounds = [];
      next.courtRounds = [];
      next.feeTier = Payments.DEFAULT_TIER; // a fresh night starts on the default fee
    }
    next.currentRound = 0;
    next.endingSoon = [];
    next.sessions = sessions;
  }
  next.sessionDate = newDate;
  next.sessionDrawAt = SD.scheduledDrawAt(newDate);
  return { ok: true, state: next };
}

/**
 * Decide whether the automatic rollover should advance the session date, and to
 * what. Pure. Advances ONLY a stale live day (sessionDate behind the current
 * night); never rewinds a future-scheduled session and never re-fires on the
 * current night. Returns the target ISO date, or null for "do nothing".
 *
 * `night` is Night.currentNight(), NOT todayISO(). That is the fix for the
 * phantom Saturday: this used to be handed "today" by a 00:00 cron, so a Friday
 * session still on court at 12:30am was closed mid-game and everything logged
 * after midnight (End of the day, payment ticks) landed on a Saturday record —
 * a day no game is ever played on, and one the draw schedule ignores. A night
 * now belongs to the day it STARTED, so the target is always a game day.
 */
function nextRolloverDate(sessionDate, night) {
  if (!night) return null;
  if (!sessionDate || sessionDate < night) return night;
  return null;
}

/** The night that owns this instant, in the server's configured timezone. */
function currentNight(nowMs) {
  return Night.currentNight(nowMs == null ? Date.now() : nowMs, parseFloat(process.env.TZ_OFFSET_HOURS || '8'));
}

/**
 * Cron entry point (hit by /api/cron-rollover at 20:00 MYT — the hour a game
 * night takes over, NOT midnight). Loads state, advances a session date that is
 * behind the current night via applySessionDateChange — which snapshots the
 * closed day to history and awards its +2 points — then persists. Idempotent:
 * a no-op when the date is already the current night or in the future, so on
 * the four non-game days it does nothing at all.
 */
async function rolloverSessionDate() {
  let state;
  try {
    state = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
  } catch (e) {
    return { ok: false, error: 'read', changed: false };
  }
  const today = todayISO();
  const night = currentNight();
  // Seed the lifetime ledger BEFORE the day closes, so the night's +2 is added
  // to a real starting total rather than to an empty map.
  ensureLifetimePoints(state);
  const target = nextRolloverDate(state.sessionDate, night);
  let next = state, dateChanged = false;
  if (target) {
    // `today` (not `night`) stays the yardstick for the month-ahead guard and
    // the 31-day history prune — those are about the real calendar.
    const transition = applySessionDateChange(state, target, today);
    if (!transition.ok) return { ok: false, error: transition.error, changed: false, today };
    next = transition.state;
    dateChanged = true;
  }
  // A new month closes the old one for the Monthly (points) draw: the final
  // points are snapshotted and everyone starts again from zero. This runs AFTER
  // the date change so the last night's +2 is inside the closed month — and it
  // is keyed on the NIGHT, not today, so a Friday 31 Oct session that runs into
  // 1 Nov keeps its points in October. The month cannot close while the night
  // that earned them is still live.
  const closedMonths = applyMonthClose(next, night || today, Date.now());
  if (!dateChanged && !closedMonths.length) return { ok: true, changed: false, sessionDate: state.sessionDate || null, today };
  try {
    await kv.set(STATE_KEY, next);
  } catch (e) {
    return { ok: false, error: 'write', changed: false, today };
  }
  return { ok: true, changed: true, from: state.sessionDate || null, to: target || state.sessionDate || null, closedMonths, today };
}

/**
 * Re-stamp every scheduled Lucky Draw time from the table in public/session-draw.js,
 * which is the single source of truth for which weekday draws when. A stamp written
 * under an older table would otherwise pin a still-pending session to the morning it
 * used to draw on. Sessions that were already drawn are untouched by this: their
 * permanent record carries its own drawAt, and the sweep skips a date that has one.
 */
function restampDrawTimes(current) {
  if (!current || typeof current !== 'object') return current;
  if (typeof current.sessionDate === 'string') current.sessionDrawAt = SD.scheduledDrawAt(current.sessionDate);
  const sessions = current.sessions;
  if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
    for (const d of Object.keys(sessions)) {
      const snap = sessions[d];
      if (snap && typeof snap === 'object') snap.drawAt = SD.scheduledDrawAt(d);
    }
  }
  return current;
}

/** Load the live state blob (or the defaults). Shared by the draws endpoint + cron. */
async function loadState() {
  return restampDrawTimes((await kv.get(STATE_KEY)) || { ...DEFAULT_STATE });
}

/**
 * Auto-close: make sure the current night has its payment list, even though
 * nobody pressed "End of the day".
 *
 * The treasurer leaves the hall at 12:30am and goes to sleep, so the button
 * usually never gets pressed on the night itself — and without a payment record
 * per player there is nothing to tick off the next afternoon, and the session
 * draw three days later sees zero paid players. This runs from the 09:00 MYT
 * cron, so the list is already waiting the morning after.
 *
 * It only CREATES the unpaid records (exactly what the button does, via the
 * same idempotent generatePayments handler). It never marks anyone paid, and it
 * never advances the session date — at 09:00 on a Saturday the current night is
 * still Friday, and it stays Friday until Sunday evening.
 */
async function autoCloseNight(opts) {
  const o = opts || {};
  const night = o.night || currentNight(o.nowMs);
  if (!night) return { ok: true, changed: false, reason: 'no night' };
  let state;
  try {
    state = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
  } catch (e) {
    return { ok: false, error: 'read', changed: false, night };
  }
  // Only ever touch the live night. A past night the admin already dealt with
  // is none of this job's business.
  if (state.sessionDate !== night) return { ok: true, changed: false, night, reason: 'session date is not the current night' };
  const day = (state.attendance || {})[night];
  if (day && day.payments) return { ok: true, changed: false, night, reason: 'already generated' };
  const r = handlePaymentAdminAction(state, { action: 'generatePayments', date: night }, { nowMs: o.nowMs != null ? o.nowMs : Date.now() });
  if (!r || !r.changed) {
    return { ok: true, changed: false, night, reason: (r && r.body && r.body.error) || 'nothing to generate' };
  }
  try {
    await kv.set(STATE_KEY, state);
  } catch (e) {
    return { ok: false, error: 'write', changed: false, night };
  }
  return { ok: true, changed: true, night, created: r.body && r.body.created, total: r.body && r.body.total };
}

/**
 * Cron entry point for the per-session Lucky Draw (hit by /api/cron-session-draw
 * daily at 09:00 MYT; also run by GET /api/draws and the admin list). Loads the
 * state and runs the idempotent sweep: every candidate session whose scheduled
 * draw time has passed and that has no result yet is drawn once (HSETNX). The
 * state blob itself is never written here.
 */
async function runSessionDrawSweep() {
  let state;
  try {
    state = await loadState();
  } catch (e) {
    return { ok: false, error: 'read', changed: false };
  }
  try {
    const r = await sweepSessionDraws(state, drawStore, {});
    return { ok: true, changed: r.drawn.length > 0, drawn: r.drawn, pending: r.pending, today: todayISO() };
  } catch (e) {
    console.error('session draw sweep error:', e && e.message);
    return { ok: false, error: 'sweep', changed: false };
  }
}

/**
 * Cron entry point for the Monthly (points) Lucky Draw — run by the same 09:00
 * MYT cron as the session draw (Hobby plans allow two crons, so they share one).
 * Closes a due month first (that DOES write the state blob: points reset), then
 * runs the idempotent sweep over the separate `court-monthly-draws` hash.
 */
async function runMonthlyDrawSweep() {
  let state;
  try {
    state = await loadState();
  } catch (e) {
    return { ok: false, error: 'read', changed: false };
  }
  // The close wipes every roster total; the lifetime ledger it leaves alone, so
  // seed it first and the reset write carries the pre-reset figures forward.
  ensureLifetimePoints(state);
  // Keyed on the night, not today — see rolloverSessionDate: a month must not
  // close out from under a session that started in it and is still running.
  const closedMonths = applyMonthClose(state, currentNight() || todayISO(), Date.now());
  if (closedMonths.length) {
    try { await kv.set(STATE_KEY, state); } catch (e) { return { ok: false, error: 'write', changed: false, closedMonths }; }
  }
  try {
    const r = await sweepMonthlyDraws(state, monthlyStore, {});
    return { ok: true, changed: r.drawn.length > 0 || closedMonths.length > 0, drawn: r.drawn, pending: r.pending, closedMonths, today: todayISO() };
  } catch (e) {
    console.error('monthly draw sweep error:', e && e.message);
    return { ok: false, error: 'sweep', changed: false, closedMonths };
  }
}

/**
 * Validate a public sign-up and return {ok, error?, fields?}. `fields` holds
 * ONLY sanitized values (name, phone, days, [skill, dates]); the handler stamps
 * id/at/handled. NEVER trusts arbitrary body keys, so submitSignup can never
 * write anything but one sanitized signup. New path: {name,phone,skill,dates[]};
 * legacy path (old cached client): {name,phone,days[]} validated vs day names.
 */
function buildSignup(body, ctx) {
  body = body || {};
  ctx = ctx || {};
  const games = Array.isArray(ctx.socialGames) ? ctx.socialGames : DEFAULT_STATE.socialGames;
  const enabledGames = games.filter((g) => g && g.enabled);
  const today = ctx.todayISO || todayISO();
  const maxISO = addMonthsISO(today, 3);

  const name = String(body.name == null ? '' : body.name).trim().slice(0, 80);
  const phone = String(body.phone == null ? '' : body.phone).trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Please enter your name.' };
  if (!phone || !/\d/.test(phone)) return { ok: false, error: 'Please enter a valid phone number.' };

  // New calendar path: specific dates + skill
  if (Array.isArray(body.dates)) {
    const skill = String(body.skill == null ? '' : body.skill).trim();
    if (SKILLS.indexOf(skill) === -1) return { ok: false, error: 'Please choose a skill level.' };
    const wdSet = new Set(
      enabledGames
        .map((g) => (Number.isFinite(g.weekday) ? g.weekday : WEEKDAY_NAMES.indexOf(g.day)))
        .filter((w) => w >= 0)
    );
    const raw = body.dates.slice(0, 60); // DoS bound before per-item work
    if (raw.length === 0) return { ok: false, error: 'Please pick at least one date.' };
    const seen = new Set();
    const clean = [];
    for (let i = 0; i < raw.length; i++) {
      const iso = String(raw[i] == null ? '' : raw[i]);
      if (!isValidISO(iso)) return { ok: false, error: 'Please pick a valid date.' };
      if (iso < today || iso > maxISO) return { ok: false, error: 'That date is out of range.' };
      if (!wdSet.has(isoWeekday(iso))) return { ok: false, error: 'Please pick a valid game day.' };
      if (!seen.has(iso)) { seen.add(iso); clean.push(iso); }
    }
    clean.sort();
    const dates = clean.slice(0, 12); // payload-growth guard
    const days = [];
    const dseen = new Set();
    dates.forEach((iso) => { const nm = weekdayName(iso); if (nm && !dseen.has(nm)) { dseen.add(nm); days.push(nm); } });
    return { ok: true, fields: { name, phone, skill, dates, days } };
  }

  // Legacy days-only path (old cached client) — validate vs enabled day NAMES
  const rawDays = Array.isArray(body.days)
    ? body.days.slice(0, 7).map((d) => String(d == null ? '' : d).slice(0, 20))
    : [];
  const allowed = new Set(enabledGames.map((g) => g.day));
  const validDays = rawDays.filter((d) => allowed.has(d));
  if (validDays.length === 0) return { ok: false, error: 'Please pick at least one game day.' };
  return { ok: true, fields: { name, phone, days: validDays } };
}

const MAX_PARTY = 5; // group sign-up: 1 organiser + up to 4 friends

/**
 * Build a group sign-up: one person brings friends, everyone shares one set of
 * dates. `body.people` is an array of {name,phone,skill}; each is validated and
 * self-built via buildSignup (rules stay in one place), so this path can NEVER
 * write anything but sanitized signup fields — arbitrary body/person keys are
 * dropped exactly as in buildSignup. Returns {ok, error?, list?} — one sanitized
 * fields object per person; person 0 is the organiser (no broughtBy), friends
 * carry broughtBy = organiser's name. With no `people[]`, falls back to a single
 * buildSignup (new single-person OR legacy days path) wrapped in a one-item list.
 */
function buildSignups(body, ctx) {
  body = body || {};
  if (!Array.isArray(body.people)) {
    const one = buildSignup(body, ctx);
    return one.ok ? { ok: true, list: [one.fields] } : one;
  }
  if (body.people.length === 0) return { ok: false, error: 'Please add at least one person.' };
  const people = body.people.slice(0, MAX_PARTY);
  const list = [];
  let organiser = '';
  for (let i = 0; i < people.length; i++) {
    const p = people[i] || {};
    const one = buildSignup({ name: p.name, phone: p.phone, skill: p.skill, dates: body.dates }, ctx);
    if (!one.ok) return one;
    if (i === 0) organiser = one.fields.name;
    else one.fields.broughtBy = organiser;
    list.push(one.fields);
  }
  return { ok: true, list };
}

const handler = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const state = await kv.get(STATE_KEY);
      const current = state || DEFAULT_STATE;
      normalizeDrawState(current);
      if (!current.roster) current.roster = DEFAULT_ROSTER;
      if (current.roster) current.roster = current.roster.map(r => r.points !== undefined ? r : { ...r, points: 0 });
      if (!Array.isArray(current.socialGames)) current.socialGames = DEFAULT_STATE.socialGames.map(g => ({ ...g }));
      if (!Array.isArray(current.signups)) current.signups = [];
      // Weekly regulars: a plain weekday->ids object. Coerce anything else (old
      // blobs, arrays, null) to {} so the editor and the Session prompt are safe.
      if (!current.regulars || typeof current.regulars !== 'object' || Array.isArray(current.regulars)) current.regulars = {};
      // Phone bottom-bar shortcuts: repair old/odd blobs to a clean list (defaults when missing).
      current.adminShortcuts = AdminNav.normalizeShortcuts(current.adminShortcuts);
      if (!Array.isArray(current.endingSoon)) current.endingSoon = [];
      if (!Array.isArray(current.accounts)) current.accounts = [];
      // Attendance/payment (additive; coerce old blobs safely).
      if (!current.attendance || typeof current.attendance !== 'object' || Array.isArray(current.attendance)) current.attendance = {};
      // Retired Weekly draw keys: scrub them from old blobs so nothing downstream sees them.
      delete current.weeklyDraws;
      delete current.weeklySettings;
      // Session draw settings + the live day's scheduled draw instant.
      current.drawSettings = { winners: SD.winnersOf(current.drawSettings), prize: SD.prizeOf(current.drawSettings), prizes: SD.prizesOf(current.drawSettings) };
      restampDrawTimes(current);
      // Monthly (points) draw: repair old/odd blobs; a missing pointsMonth means "this month".
      current.monthlyLucky = ML.normalize(current.monthlyLucky, todayISO());
      // Lifetime points: seed/repair the map (stripped again by publicProjection —
      // this keeps a read and a write agreeing on the same starting totals).
      ensureLifetimePoints(current);
      if (!Array.isArray(current.audit)) current.audit = [];
      // Session fee tier: coerce anything but '2h'/'3h' (old blobs, junk) to the default.
      current.feeTier = Payments.tierOf(current.feeTier);
      // Prune attendance past the retention window on every read.
      pruneWeeklyState(current, todayISO());
      if (current.siteCode) {
        const provided = (req.query && req.query.code) ? req.query.code : '';
        if (provided !== current.siteCode) {
          // Still surface the open game days so the locked screen can show its
          // "Join our social games" CTA. Nothing else leaks while locked.
          const openGames = current.socialGames
            .filter(g => g && g.enabled)
            .map(g => ({ id: g.id, day: g.day, weekday: g.weekday, time: g.time, enabled: true }));
          // `today` lets the locked join calendar use the SERVER's day boundary
          // (not the visitor's browser clock) as its lower bound.
          return res.status(200).json({ locked: true, socialGames: openGames, today: todayISO() });
        }
      }
      // publicProjection strips the accounts array (credentials) AND the private
      // attendance/audit/monthly-eligibility data — so a GET payload can never
      // leak one player's private data (attendance/payment/password) to another.
      // Admins get full data via their authenticated poll (redactState only).
      return res.json({ ...publicProjection(current), serverTime: Date.now(), today: todayISO() });
    } catch (e) {
      console.error('KV read error:', e.message);
      return res.json({ ...publicProjection(DEFAULT_STATE), serverTime: Date.now(), today: todayISO() });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};

    // Public, UNAUTHENTICATED sign-up submission. This is the ONLY POST path
    // that does not require the admin password. It can ONLY ever append one
    // sanitized signup — it self-builds the signup object and never spreads
    // req.body into state, so it cannot overwrite siteCode, roster, players,
    // socialGames, etc. It returns in every branch, so a submitSignup request
    // can never fall through to the password-gated update logic below.
    if (b.action === 'submitSignup') {
      // Honeypot: bots fill hidden fields. Pretend success, store nothing.
      if (String(b.hp || '').trim()) return res.json({ ok: true });

      let s;
      try {
        s = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
      } catch (e) {
        s = { ...DEFAULT_STATE };
      }

      // buildSignups self-builds sanitized signups from people[]/name/phone/skill/
      // dates (or legacy days), validated against the server's enabled days +
      // clock. It NEVER spreads req.body, so this path can only ever append
      // sanitized signups — one per person in a group, capped at MAX_PARTY.
      const built = buildSignups(b, { socialGames: s.socialGames, todayISO: todayISO() });
      if (!built.ok) {
        return res.status(400).json({ error: built.error || 'Please complete the form.' });
      }

      // One timestamp for the whole group so its rows sort adjacently (organiser
      // first). id is at+index+random so batch members never collide.
      const at = Date.now();
      const stamped = built.list.map((fields, i) => Object.assign(
        { id: 'su' + at.toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 6), at, handled: false },
        fields
      ));
      const existing = Array.isArray(s.signups) ? s.signups : [];
      // Append-only, newest first, hard-capped at 500 (drop oldest). This slice
      // is the LAST mutation on every append — the array can never grow unbounded.
      s.signups = [...stamped, ...existing].slice(0, 500);

      try {
        await kv.set(STATE_KEY, s);
      } catch (e) {
        console.error('KV write error (signup):', e.message);
        return res.status(500).json({ error: 'Storage error.' });
      }
      return res.json({ ok: true });
    }

    // Public, UNAUTHENTICATED account actions (register / login / session /
    // update profile / logout). Like submitSignup, this path is gated only by
    // the site-access code on the client; it never reaches the admin-password
    // logic below (it returns in every branch). handleAccountAction mutates a
    // freshly-loaded state copy and tells us whether to persist; it self-builds
    // every record and never spreads req.body, so it can only ever touch the
    // accounts array and the roster player it owns.
    // A signed-in member's OWN page (points, what they owe, draw wins). Token-
    // gated inside handleMemberInfo, self-only, read-only: it reads the two draw
    // hashes but never writes the state blob. Returns in every branch.
    if (b.action === 'memberInfo') {
      let s;
      try {
        s = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
      } catch (e) {
        s = { ...DEFAULT_STATE };
      }
      const result = await handleMemberInfo(s, b, { drawStore, monthlyStore });
      return res.status(result.status).json(result.body);
    }

    if (b.action && ACCOUNT_ACTIONS.has(b.action)) {
      let s;
      try {
        s = (await kv.get(STATE_KEY)) || { ...DEFAULT_STATE };
      } catch (e) {
        s = { ...DEFAULT_STATE };
      }
      const result = handleAccountAction(s, b);
      if (result.changed) {
        try {
          await kv.set(STATE_KEY, s);
        } catch (e) {
          console.error('KV write error (account):', e.message);
          return res.status(500).json({ error: 'Storage error.' });
        }
      }
      return res.status(result.status).json(result.body);
    }

    const { password, ...updates } = req.body || {};

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let state;
    try {
      state = restampDrawTimes((await kv.get(STATE_KEY)) || { ...DEFAULT_STATE });
    } catch (e) {
      state = { ...DEFAULT_STATE };
    }
    // Every admin write below starts here, so seeding the lifetime ledger once,
    // up front, means the first write of ANY kind persists it — and every
    // branch that credits points is adding to a real total, never to {}.
    ensureLifetimePoints(state);

    // Auth-only ping (no updates): return state so an authenticated admin can
    // bypass the site lock and reach the admin panel even without the site code.
    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, state: { ...liteMonthlyLucky(redactState(state)), serverTime: Date.now() } });
    }

    // Handle admin account-management actions (list / approve / reject / reveal / ...)
    if (updates.action && ADMIN_ACCOUNT_ACTIONS.has(updates.action)) {
      const result = handleAdminAccountAction(state, updates, { adminPassword: ADMIN_PASSWORD });
      if (result.changed) {
        try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error.' }); }
      }
      return res.status(result.status).json(result.body);
    }

    // Handle admin attendance / monthly-eligibility actions.
    if (updates.action && WEEKLY_ADMIN_ACTIONS.has(updates.action)) {
      const result = handleWeeklyAdminAction(state, updates);
      if (result.changed) {
        try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error.' }); }
      }
      return res.status(result.status).json(result.body);
    }

    // Handle admin per-player session payment actions ("End of the day" + paid/method/fee edits).
    if (updates.action && PAYMENT_ADMIN_ACTIONS.has(updates.action)) {
      const result = handlePaymentAdminAction(state, updates);
      if (result.changed) {
        try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error.' }); }
      }
      return res.status(result.status).json(result.body);
    }

    // Handle admin session-draw actions (manual "Run draw now", winners setting,
    // admin copy of the draw list). The handler is async: it talks to the
    // separate draw store; the state blob is saved only when it changed.
    if (updates.action && SESSION_DRAW_ADMIN_ACTIONS.has(updates.action)) {
      const result = await handleSessionDrawAdminAction(state, updates, { store: drawStore });
      if (result.changed) {
        try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error.' }); }
      }
      return res.status(result.status).json(result.body);
    }

    // Handle admin Monthly (points) draw actions: settings, prizes, pool, manual
    // draw, admin list. getMonthlyDraws also closes a due month (points reset),
    // so the state blob is saved whenever the handler reports a change.
    if (updates.action && MONTHLY_LUCKY_ADMIN_ACTIONS.has(updates.action)) {
      const result = await handleMonthlyLuckyAdminAction(state, updates, { store: monthlyStore });
      if (result.changed) {
        try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error.' }); }
      }
      return res.status(result.status).json(result.body);
    }

    // Admin fetch of the full private ops data (attendance / drawSettings /
    // audit / lifetime points) — kept out of public GET.
    if (updates.action === 'adminGetOps') {
      return res.json({
        ok: true,
        attendance: state.attendance || {},
        drawSettings: { winners: SD.winnersOf(state.drawSettings), prize: SD.prizeOf(state.drawSettings), prizes: SD.prizesOf(state.drawSettings) },
        audit: Array.isArray(state.audit) ? state.audit.slice(0, 300) : [],
        feeTier: Payments.tierOf(state.feeTier),
        sessionDate: state.sessionDate || null,
        lifetimePoints: state.lifetimePoints || {},
        // Phone numbers by player, so Session and Payments can show who to call
        // without loading the (heavy, secret-carrying) accounts array.
        phones: playerPhoneMap(state),
      });
    }

    // Handle deleteSession action
    if (updates.action === 'deleteSession') {
      const { date } = updates;
      if (state.sessions) delete state.sessions[date];
      try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error' }); }
      return res.json({ ok: true });
    }

    // Bulk "Add Multiple to Roster". Carries only the names — see buildRosterAdditions.
    if (updates.action === 'addRosterPlayers') {
      const built = buildRosterAdditions(state.roster, updates.names, Date.now());
      if (!built.ok) return res.status(400).json({ error: built.error });
      state.roster = [...(Array.isArray(state.roster) ? state.roster : []), ...built.players];
      try {
        await kv.set(STATE_KEY, state);
      } catch (e) {
        console.error('KV write error (addRosterPlayers):', e.message);
        return res.status(500).json({ error: 'Storage error.' });
      }
      return res.json({ ok: true, added: built.players.length, roster: state.roster });
    }

    // Manual points edit from the Players list (organiser override).
    if (updates.action === 'setRosterPoints') {
      const built = buildRosterPointsUpdate(state.roster, updates.playerId, updates);
      if (!built.ok) return res.status(400).json({ error: built.error });
      if (built.prev !== built.next) {
        state.roster = built.roster;
        // The lifetime ledger follows the SIGNED change, so a correction of a
        // mis-typed award takes itself back out again instead of inflating the
        // permanent total forever.
        state.lifetimePoints = addLifetimePoints(state.lifetimePoints, built.player.id, built.next - built.prev);
        pushAudit(state, {
          action: 'roster.points',
          admin: 'admin',
          target: { type: 'player', id: built.player.id, label: built.player.name || built.player.id },
          prevValue: built.prev,
          newValue: built.next,
        });
        try {
          await kv.set(STATE_KEY, state);
        } catch (e) {
          console.error('KV write error (setRosterPoints):', e.message);
          return res.status(500).json({ error: 'Storage error.' });
        }
      }
      return res.json({ ok: true, playerId: built.player.id, points: built.next, roster: state.roster, lifetime: lifetimeOf(state.lifetimePoints, built.player.id) });
    }

    // Handle updateSession action (edit a historical session)
    if (updates.action === 'updateSession') {
      const { date, session } = updates;
      if (date > todayISO()) return res.status(400).json({ error: 'Cannot create a session for a future date.' });
      state.sessions = { ...(state.sessions || {}), [date]: session };
      try { await kv.set(STATE_KEY, state); } catch (e) { return res.status(500).json({ error: 'Storage error' }); }
      return res.json({ ok: true });
    }

    // Every named action is handled above; an unknown one must never fall through
    // to the generic merge (it would write `action`/`date` junk into the blob).
    if (updates.action !== undefined) {
      return res.status(400).json({ error: 'Unknown action.' });
    }

    // Session fee tier rides the generic merge like numCourts, but it's an enum — reject junk.
    if (updates.feeTier !== undefined && !Payments.isTier(updates.feeTier)) {
      return res.status(400).json({ error: 'Invalid fee tier.' });
    }
    // Draw settings have their own validated action; never accept them via the merge.
    if (updates.drawSettings !== undefined || updates.sessionDrawAt !== undefined) {
      return res.status(400).json({ error: 'Use the setDrawSettings action.' });
    }
    // The monthly (points) draw blob holds point snapshots — never accept it via the merge.
    if (updates.monthlyLucky !== undefined) {
      return res.status(400).json({ error: 'Use the monthly draw actions.' });
    }
    // Lifetime points are the server's own record: they are never sent to the
    // client on a poll, so anything arriving here is stale or forged. Refusing
    // it outright is what makes the ledger safe from the whole-roster merge.
    if (updates.lifetimePoints !== undefined) {
      return res.status(400).json({ error: 'Lifetime points are kept by the server.' });
    }
    // Phone bottom-bar shortcuts ride the generic merge, but only as a clean list of
    // 1–4 known, unique tab ids (canonical order is enforced server-side).
    if (updates.adminShortcuts !== undefined) {
      if (!AdminNav.isValidShortcuts(updates.adminShortcuts)) {
        return res.status(400).json({ error: 'Invalid shortcuts.' });
      }
      updates.adminShortcuts = AdminNav.normalizeShortcuts(updates.adminShortcuts);
    }

    // Session date change: allow scheduling up to a month ahead (matches the
    // admin UI), snapshot the outgoing day, and restore the target day's saved
    // session if we have one. Shared pure helper — see applySessionDateChange.
    if (updates.sessionDate) {
      const transition = applySessionDateChange(state, updates.sessionDate);
      if (!transition.ok) return res.status(400).json({ error: transition.error });
      state = transition.state;
    }

    state = { ...state, ...updates };

    try {
      await kv.set(STATE_KEY, state);
    } catch (e) {
      console.error('KV write error:', e.message);
      return res.status(500).json({ error: 'Storage error. Add Upstash Redis from Vercel Marketplace and link it to this project.' });
    }

    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports = handler;
module.exports.normalizeDrawState = normalizeDrawState;
module.exports.buildSignup = buildSignup;
module.exports.buildSignups = buildSignups;
module.exports.addMonthsISO = addMonthsISO;
module.exports.addDaysISO = addDaysISO;
module.exports.applySessionDateChange = applySessionDateChange;
module.exports.currentNight = currentNight;
module.exports.autoCloseNight = autoCloseNight;
module.exports.awardSessionPoints = awardSessionPoints;
module.exports.addLifetimePoints = addLifetimePoints;
module.exports.ensureLifetimePoints = ensureLifetimePoints;
module.exports.lifetimeOf = lifetimeOf;
module.exports.MAX_LIFETIME_POINTS = MAX_LIFETIME_POINTS;
module.exports.paidEntryExpiry = paidEntryExpiry;
module.exports.pruneExpiredPaid = pruneExpiredPaid;
module.exports.regularsToAdd = regularsToAdd;
module.exports.seedRegularPlayers = seedRegularPlayers;
module.exports.nextRolloverDate = nextRolloverDate;
module.exports.rolloverSessionDate = rolloverSessionDate;
module.exports.loadState = loadState;
module.exports.drawStore = drawStore;
module.exports.monthlyStore = monthlyStore;
module.exports.runSessionDrawSweep = runSessionDrawSweep;
module.exports.runMonthlyDrawSweep = runMonthlyDrawSweep;
module.exports.buildMonthlyView = buildMonthlyView;
module.exports.publicProjection = publicProjection;
module.exports.todayISO = todayISO;
module.exports.buildRosterAdditions = buildRosterAdditions;
module.exports.buildRosterPointsUpdate = buildRosterPointsUpdate;
module.exports.isPointsValue = isPointsValue;
module.exports.MAX_POINTS = MAX_POINTS;
module.exports.MAX_ROSTER = MAX_ROSTER;
module.exports.MAX_BULK_ADD = MAX_BULK_ADD;
module.exports.MAX_ROSTER_NAME = MAX_ROSTER_NAME;
