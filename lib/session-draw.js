'use strict';
/*
 * session-draw.js — server-side wiring for the automatic per-session Lucky Draw.
 *
 * Pure rules (schedule table, eligibility, seeded shuffle, record shape, page view)
 * live in public/session-draw.js and are shared with the browser + unit tests. This
 * module adds: the draw STORE (a Redis hash `court-draws`, one field per session
 * date, written with HSETNX so a result can never be written twice — even when the
 * cron, a page view and an admin click race), the idempotent sweep every trigger
 * calls, the admin actions, and the JSON view the Lucky Draw page fetches.
 *
 * Results are permanent: nothing here deletes or rewrites a record.
 *
 * Actions (admin-password gated by api/state.js):
 *   runDraw {date}            — manual fallback; refused before the scheduled time or when drawn
 *   setDrawSettings {winners} — winners per draw (1..10)
 *   getDraws {limit?, before?}— admin copy of the page view (runs the sweep first)
 * NOTE: never reuse the field name `password` here — the dispatcher strips it as admin auth.
 */
const crypto = require('crypto');
const SD = require('../public/session-draw.js');
const { pushAudit } = require('./audit.js');

const DRAWS_KEY = (process.env.TZH_KEY_PREFIX || '') + 'court-draws';
const SESSION_DRAW_ADMIN_ACTIONS = new Set(['runDraw', 'setDrawSettings', 'setDrawPrizes', 'getDraws']);
const DEFAULT_DRAW_SETTINGS = { winners: SD.DEFAULT_WINNERS };

function offsetHours() { return parseFloat(process.env.TZ_OFFSET_HOURS || '8'); }
function newSeed() { return crypto.randomBytes(16).toString('hex'); }
function bad(msg) { return { status: 400, body: { error: msg }, changed: false }; }
function settingsOf(state) {
  return {
    winners: SD.winnersOf(state && state.drawSettings),
    prize: SD.prizeOf(state && state.drawSettings),
    prizes: SD.prizesOf(state && state.drawSettings),
  };
}

function parseRec(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return typeof v === 'object' ? v : null;
}

/** In-memory store with the same contract as the Redis one (server.js, dev-server.js, tests). */
function memoryDrawStore(initial) {
  const map = new Map(Object.keys(initial || {}).map((d) => [d, JSON.stringify(initial[d])]));
  return {
    async getAll() { const out = {}; for (const [d, v] of map) out[d] = parseRec(v); return out; },
    async get(date) { return map.has(date) ? parseRec(map.get(date)) : null; },
    async putIfAbsent(date, rec) { if (map.has(date)) return false; map.set(date, JSON.stringify(rec)); return true; },
    size() { return map.size; },
  };
}

/** Redis-hash store. `client` needs hget/hgetall/hsetnx (the kv façade in api/state.js). */
function redisDrawStore(client, key) {
  const k = key || DRAWS_KEY;
  return {
    async getAll() {
      const all = await client.hgetall(k);
      const out = {};
      for (const d of Object.keys(all || {})) { const r = parseRec(all[d]); if (r) out[d] = r; }
      return out;
    },
    async get(date) { return parseRec(await client.hget(k, date)); },
    async putIfAbsent(date, rec) {
      const r = await client.hsetnx(k, date, JSON.stringify(rec));
      return r === 1 || r === true;
    },
  };
}

/**
 * Idempotent sweep: draw every candidate session whose scheduled time has passed
 * and that has no record yet. Called by the cron, by the page view, and by the
 * admin list. Never touches `state`. Clock/seed/method are injectable for tests.
 * Returns { drawn:[dates], pending:[dates not yet due], results:{date:rec} }.
 */
async function sweepSessionDraws(state, store, opts) {
  const o = opts || {};
  const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const off = o.offsetHours != null ? o.offsetHours : offsetHours();
  const seedFn = typeof o.seedFn === 'function' ? o.seedFn : newSeed;
  const method = o.method === 'manual' ? 'manual' : 'auto';
  const settings = settingsOf(state);
  const results = await store.getAll();
  const drawn = [], pending = [];
  for (const c of SD.sessionCandidates(state, off)) {
    if (results[c.date]) continue;                                     // already drawn — idempotent
    if (!Number.isFinite(c.drawAt) || now < c.drawAt) { pending.push(c.date); continue; }
    const rec = SD.buildDrawResult({
      date: c.date, drawAt: c.drawAt, day: c.day, lineup: c.lineup,
      winnersWanted: settings.winners, seed: seedFn(), nowMs: now, method,
    });
    if (await store.putIfAbsent(c.date, rec)) {
      drawn.push(c.date);
      results[c.date] = rec;
    } else {
      results[c.date] = await store.get(c.date);                        // someone else won the race
    }
  }
  return { drawn, pending, results };
}

/** The Lucky Draw page payload. `opts.results` skips a second store read after a sweep. */
async function buildDrawsView(state, store, opts) {
  const o = opts || {};
  const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const off = o.offsetHours != null ? o.offsetHours : offsetHours();
  const results = o.results || await store.getAll();
  const settings = settingsOf(state);
  const view = SD.buildView(state, results, { nowMs: now, settings, limit: o.limit, before: o.before, offsetHours: off });
  // sessionPrizes carries the photos; the 2 s poll gets the same list without them.
  return { winnersPerDraw: settings.winners, sessionPrize: settings.prize, sessionPrizes: settings.prizes,
    sessions: view.sessions, hasMore: view.hasMore, nextBefore: view.nextBefore };
}

// ── admin actions ────────────────────────────────────────────────────
async function doRunDraw(state, body, o) {
  const date = body && body.date;
  if (!SD.isValidISO(date)) return bad('Invalid date.');
  if (!SD.isDrawDay(date)) return bad('No draw is scheduled for that day of the week.');
  const existing = await o.store.get(date);
  if (existing) return { status: 409, body: { error: 'This session has already been drawn.', result: existing }, changed: false };
  const cand = SD.sessionCandidates(state, o.offsetHours).find((c) => c.date === date);
  if (!cand) return { status: 404, body: { error: 'No session found for that date.' }, changed: false };
  if (!Number.isFinite(cand.drawAt)) return bad('No draw is scheduled for that session.');
  if (o.nowMs < cand.drawAt) {
    return { status: 400, body: { error: 'Draw time not reached yet — scheduled for ' + SD.fmtDrawTime(cand.drawAt) + '.', drawAt: cand.drawAt }, changed: false };
  }
  const rec = SD.buildDrawResult({
    date, drawAt: cand.drawAt, day: cand.day, lineup: cand.lineup,
    winnersWanted: settingsOf(state).winners, seed: o.seedFn(), nowMs: o.nowMs, method: 'manual',
  });
  if (!(await o.store.putIfAbsent(date, rec))) {
    return { status: 409, body: { error: 'This session has already been drawn.', result: await o.store.get(date) }, changed: false };
  }
  pushAudit(state, { action: 'draw.run', admin: 'admin', at: o.nowMs,
    target: { type: 'sessionDraw', id: date, label: 'Session draw ' + date },
    newValue: rec.winners.map((id) => rec.names[id] || id),
    note: 'manual · ' + rec.counts.eligible + ' eligible' + (rec.shortfall ? ' · short of ' + rec.winnersWanted : '') });
  return { status: 200, body: { ok: true, result: rec }, changed: true };
}

// Winners count and the prize line are set independently: a body carrying only
// `prize` must not reset the winner count (and vice versa), so each key is
// applied only when the caller actually sent it.
function doSetDrawSettings(state, body, o) {
  const b = body || {};
  const cur = settingsOf(state);
  const hasWinners = b.winners !== undefined, hasPrize = b.prize !== undefined;
  if (!hasWinners && !hasPrize) return bad('Nothing to change.');

  let winners = cur.winners, prize = cur.prize;
  if (hasWinners) {
    const n = Number(b.winners);
    if (!SD.isWinnersCount(n)) return bad('Winners per draw must be a whole number from 1 to ' + SD.MAX_WINNERS + '.');
    winners = n;
  }
  if (hasPrize) {
    if (b.prize !== null && typeof b.prize !== 'string') return bad('Invalid prize.');
    if (typeof b.prize === 'string' && b.prize.trim().length > SD.MAX_PRIZE_LEN) {
      return bad('The prize line must be ' + SD.MAX_PRIZE_LEN + ' characters or fewer.');
    }
    prize = SD.prizeOf({ prize: b.prize == null ? '' : b.prize });
  }
  if (winners === cur.winners && prize === cur.prize) {
    return { status: 200, body: { ok: true, drawSettings: cur, unchanged: true }, changed: false };
  }
  state.drawSettings = { winners, prize, prizes: cur.prizes };
  if (hasWinners && winners !== cur.winners) {
    pushAudit(state, { action: 'draw.settings', admin: 'admin', at: o.nowMs,
      target: { type: 'drawSettings', id: 'winners', label: 'Winners per draw' }, prevValue: cur.winners, newValue: winners });
  }
  if (hasPrize && prize !== cur.prize) {
    pushAudit(state, { action: 'draw.settings', admin: 'admin', at: o.nowMs,
      target: { type: 'drawSettings', id: 'prize', label: 'Session draw prize' }, prevValue: cur.prize, newValue: prize });
  }
  return { status: 200, body: { ok: true, drawSettings: state.drawSettings }, changed: true };
}

/**
 * The prizes on offer in every session draw — the same shape as the Monthly
 * ones (one per place, with a photo), so both draws are set up the same way.
 * Unlike Monthly's, these are NOT snapshotted into a draw record: a session
 * record stores winners only, and this list is what is currently on offer.
 */
function doSetDrawPrizes(state, body, o) {
  const check = SD.validatePrizeList(body && body.prizes);
  if (!check.ok) return bad(check.error);
  const prizes = SD.normalizePrizes(body.prizes);
  const cur = settingsOf(state);
  state.drawSettings = { winners: cur.winners, prize: cur.prize, prizes };
  pushAudit(state, { action: 'draw.prizes', admin: 'admin', at: o.nowMs,
    target: { type: 'drawSettings', id: 'prizes', label: 'Session draw prizes' },
    prevValue: cur.prizes.map(SD.prizeLabel), newValue: prizes.map(SD.prizeLabel) });
  return { status: 200, body: { ok: true, prizes }, changed: true };
}

async function doGetDraws(state, body, o) {
  let results = null;
  try { results = (await sweepSessionDraws(state, o.store, { nowMs: o.nowMs, offsetHours: o.offsetHours, seedFn: o.seedFn })).results; } catch (e) { /* view still loads */ }
  const limit = Number(body && body.limit);
  const view = await buildDrawsView(state, o.store, { results, nowMs: o.nowMs, offsetHours: o.offsetHours, limit: Number.isInteger(limit) && limit > 0 ? limit : undefined, before: body && body.before });
  return { status: 200, body: Object.assign({ ok: true }, view), changed: false };
}

/** Dispatcher entry. `opts.store` is required; nowMs/seedFn/offsetHours are injectable for tests. */
async function handleSessionDrawAdminAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return bad('Invalid request.');
    const o = opts || {};
    if (!o.store) return { status: 500, body: { error: 'Draw storage unavailable.' }, changed: false };
    const ctx = {
      store: o.store,
      nowMs: o.nowMs != null ? Number(o.nowMs) : Date.now(),
      offsetHours: o.offsetHours != null ? o.offsetHours : offsetHours(),
      seedFn: typeof o.seedFn === 'function' ? o.seedFn : newSeed,
    };
    switch (body && body.action) {
      case 'runDraw':         return await doRunDraw(state, body, ctx);
      case 'setDrawSettings': return doSetDrawSettings(state, body, ctx);
      case 'setDrawPrizes':   return doSetDrawPrizes(state, body, ctx);
      case 'getDraws':        return await doGetDraws(state, body, ctx);
      default:                return bad('Unknown action.');
    }
  } catch (e) {
    return bad('Invalid request.');
  }
}

module.exports = {
  DRAWS_KEY, SESSION_DRAW_ADMIN_ACTIONS, DEFAULT_DRAW_SETTINGS,
  newSeed, settingsOf, memoryDrawStore, redisDrawStore,
  sweepSessionDraws, buildDrawsView, handleSessionDrawAdminAction,
};
