'use strict';
/*
 * knockout.js — server-side handlers for the open competition.
 *
 * Pure logic lives in public/knockout.js (shared with the browser + unit-tested);
 * this module wires it into the {status, body, changed} handler contract and the
 * audit log, exactly like lib/payments.js and lib/weekly.js.
 *
 * TWO DOORS, DELIBERATELY DIFFERENT
 *   PUBLIC (no password, gated only by the category's printed code):
 *     knockoutLookup        — "what is this code?", returns a public-safe card
 *     submitKnockoutEntry   — append pending entries; can touch NOTHING else
 *   ADMIN (password-gated by api/state.js before it ever reaches here):
 *     everything else — categories, confirmations, seeding, draws, results
 *   The public handlers self-build every record and never spread the request
 *   body, so the open door can only ever append a sanitized entrant.
 *
 * IC / PASSPORT NUMBERS
 *   An IC arrives in plaintext on the public POST and is encrypted immediately
 *   with AES-256-GCM (lib/crypto.js, key in ACCOUNT_ENC_KEY) before it is put
 *   anywhere near the state blob. What is stored is { icEnc, icLast4 } and
 *   nothing else — the plaintext is never written, never logged and never
 *   returned by any read. Only `knockoutRevealIC` decrypts one, one player at a
 *   time, for an authenticated admin, and every reveal is written to the audit
 *   log with who was looked at.
 *
 *   If no key is configured the entry is still accepted, with icEnc null and
 *   only the last four kept, because a missing env var must never cost the club
 *   an entry on tournament night. `knockoutSettings()` reports that state so the
 *   admin UI can say so out loud.
 *
 * NOTE: never use the field name `password` in a body here — api/state.js
 * strips it as admin auth before the action ever arrives.
 */
const K = require('../public/knockout.js');
const { encryptPassword, decryptPassword, hasKey, NoKeyError } = require('./crypto.js');
const { pushAudit } = require('./audit.js');

const KNOCKOUT_PUBLIC_ACTIONS = new Set(['knockoutLookup', 'submitKnockoutEntry']);

const KNOCKOUT_ADMIN_ACTIONS = new Set([
  'knockoutGetAdmin',
  'knockoutSetEvent',
  'knockoutAddCategory', 'knockoutUpdateCategory', 'knockoutDeleteCategory', 'knockoutNewCode',
  'knockoutAddEntrant', 'knockoutSetEntrant', 'knockoutDeleteEntrant', 'knockoutRevealIC',
  'knockoutSeed', 'knockoutGenerateDraw', 'knockoutClearDraw',
  'knockoutSetResult', 'knockoutClearResult', 'knockoutSetCourt',
]);

const MAX_REVEALS_LOGGED = 500;

function bad(msg) { return { status: 400, body: { error: msg || 'Invalid request.' }, changed: false }; }
function ok(body, changed) { return { status: 200, body: Object.assign({ ok: true }, body || {}), changed: !!changed }; }

/** Ensure state.knockout exists and is the current shape. Returns it. */
function ensureKnockout(state) {
  if (!state || typeof state !== 'object') return K.emptyKnockout();
  state.knockout = K.normalize(state.knockout || K.emptyKnockout());
  return state.knockout;
}

function catById(ko, id) { return (ko.categories || []).find((c) => c.id === String(id || '')) || null; }
function entById(cat, id) { return (cat.entrants || []).find((e) => e.id === String(id || '')) || null; }

// ── IC encryption ────────────────────────────────────────────────────
// lib/crypto.js is named for its first caller (the admin password-reveal
// helper) but is a generic AES-256-GCM string box; these two wrappers exist so
// the intent is readable at the call site and so a future key rotation only has
// to be understood in one place.

/** { icEnc, icLast4 } for a plaintext IC. Never returns the plaintext. */
function sealIC(plain) {
  const last4 = K.icLast4(plain);
  const norm = K.normIC(plain);
  if (!norm) return { icEnc: null, icLast4: '' };
  try {
    return { icEnc: encryptPassword(norm), icLast4: last4 };
  } catch (e) {
    // No key configured: keep the last four so the admin can still match a
    // person at the desk, and drop the rest on the floor rather than storing it.
    if (e && e.noKey) return { icEnc: null, icLast4: last4 };
    throw e;
  }
}

function openIC(blob) { return decryptPassword(blob); }

/** What the admin UI needs to know about IC handling in this deployment. */
function knockoutSettings() {
  return { encryption: hasKey() ? 'on' : 'off', codeLength: K.CODE_LEN, maxPerSubmit: K.MAX_PER_SUBMIT, autoRoundRobinMax: K.AUTO_RR_MAX };
}

// ── public: what does this code open? ────────────────────────────────

/**
 * A public-safe card for one code. Deliberately thin: the name of the category,
 * what it costs, how many places are left and how many players it needs. No
 * entrant list, no other category, and never an echo of another code.
 */
function doLookup(state, body) {
  const ko = ensureKnockout(state);
  const code = K.normCode(body && body.code);
  if (!K.isValidCode(code)) return { status: 200, body: { ok: false, error: 'That code doesn’t look right.' }, changed: false };
  const cat = K.findByCode(ko, code);
  if (!cat) return { status: 200, body: { ok: false, error: 'We don’t recognise that code.' }, changed: false };
  if (!ko.event.regOpen || cat.status !== 'open') {
    return { status: 200, body: { ok: false, error: 'Entries for this category are closed.' }, changed: false };
  }
  const left = K.spacesLeft(cat);
  if (left === 0) return { status: 200, body: { ok: false, error: 'This category is full.' }, changed: false };
  return {
    status: 200,
    body: {
      ok: true,
      category: {
        id: cat.id, name: cat.name, type: cat.type, fee: cat.fee,
        players: K.playersNeeded(cat.type), spacesLeft: left, entries: K.confirmedOf(cat).length,
      },
      event: { name: ko.event.name, date: ko.event.date, venue: ko.event.venue, requireIC: ko.event.requireIC, payTo: ko.event.payTo },
      maxPerSubmit: K.MAX_PER_SUBMIT,
    },
    changed: false,
  };
}

// ── public: submit entries ───────────────────────────────────────────

/**
 * Append 1..MAX_PER_SUBMIT pending entrants to the category the code opens.
 * Self-builds every record from validated fields, so this path can never write
 * anything but entrants — not the event, not another category, not the roster.
 */
function doSubmitEntry(state, body, now, rand) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = K.findByCode(ko, b.code);
  if (!cat) return bad('We don’t recognise that code.');

  const v = K.validateSubmission(b, { category: cat, requireIC: ko.event.requireIC, regOpen: ko.event.regOpen });
  if (!v.ok) return bad(v.error);

  const live = catById(ko, cat.id);
  if (!live) return bad('We don’t recognise that code.');

  const made = [];
  for (let i = 0; i < v.clean.entries.length; i++) {
    const players = v.clean.entries[i].players;
    if (K.isDuplicateEntry(live, players)) {
      return bad('That entry is already in ' + (live.name || 'this category') + '. Check with us if you think this is wrong.');
    }
    // Seal each IC before it goes anywhere near the state blob. `ic` is dropped
    // here and exists nowhere afterwards.
    const stored = players.map((p) => {
      const sealed = sealIC(p.ic);
      return { name: p.name, phone: p.phone, club: p.club, icLast4: sealed.icLast4, icEnc: sealed.icEnc };
    });
    const entrant = {
      id: K.newId('ke', now + i, rand),
      at: now,
      status: 'pending',
      paid: false,
      paidAt: null,
      seed: null,
      note: '',
      players: stored,
    };
    live.entrants.push(entrant);
    made.push(entrant);
    // Re-check the cap after each append so a racing submission cannot overfill.
    if (K.isFull(live) && i < v.clean.entries.length - 1) {
      return bad('This category filled up while you were entering. We saved what fitted.');
    }
  }
  live.entrants = live.entrants.slice(0, K.MAX_ENTRANTS);

  return ok({
    entered: made.length,
    category: { id: live.id, name: live.name, type: live.type, fee: live.fee },
    // What the Payment step shows. The entry is PENDING until an admin confirms
    // the money arrived, and the response says so plainly.
    fee: live.fee * made.length,
    payTo: ko.event.payTo,
    labels: made.map((e) => K.entrantLabel(e)),
  }, true);
}

// ── admin: event + categories ────────────────────────────────────────

function doSetEvent(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const prev = Object.assign({}, ko.event);
  const next = K.normalizeEvent({
    name:      b.name      === undefined ? prev.name      : b.name,
    date:      b.date      === undefined ? prev.date      : b.date,
    venue:     b.venue     === undefined ? prev.venue     : b.venue,
    regOpen:   b.regOpen   === undefined ? prev.regOpen   : !!b.regOpen,
    published: b.published === undefined ? prev.published : !!b.published,
    requireIC: b.requireIC === undefined ? prev.requireIC : !!b.requireIC,
    payTo:     b.payTo     === undefined ? prev.payTo     : b.payTo,
  });
  ko.event = next;
  const changedKeys = Object.keys(next).filter((k) => prev[k] !== next[k]);
  if (!changedKeys.length) return ok({ event: next }, false);
  pushAudit(state, {
    action: 'knockout.event', admin: 'admin', at: now,
    target: { type: 'knockout', id: 'event', label: next.name || 'Competition' },
    prevValue: changedKeys.reduce((o, k) => (o[k] = prev[k], o), {}),
    newValue: changedKeys.reduce((o, k) => (o[k] = next[k], o), {}),
  });
  return ok({ event: next }, true);
}

function doAddCategory(state, body, now, rand) {
  const ko = ensureKnockout(state);
  const b = body || {};
  if (ko.categories.length >= K.MAX_CATEGORIES) return bad('Up to ' + K.MAX_CATEGORIES + ' categories.');
  const name = String(b.name == null ? '' : b.name).replace(/\s+/g, ' ').trim();
  if (name.length < 2) return bad('Give the category a name, e.g. "Men’s Doubles Open".');
  let code = K.normCode(b.code);
  if (code) { if (!K.isValidCode(code)) return bad('A code needs 4 to 12 letters or digits.'); if (K.codeTaken(ko, code)) return bad('Another category already uses that code.'); }
  else code = K.freshCode(ko, rand);
  const cat = K.normalizeCategory({
    id: K.newId('kc', now, rand), name, type: b.type, code,
    format: b.format, cap: b.cap, fee: b.fee, status: 'setup', entrants: [], draw: null,
  });
  ko.categories.push(cat);
  pushAudit(state, { action: 'knockout.category.add', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, newValue: { type: cat.type, code: cat.code, cap: cat.cap, fee: cat.fee } });
  return ok({ category: K.summary(cat) }, true);
}

function doUpdateCategory(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  const prev = K.summary(cat);
  if (b.name !== undefined) {
    const n = String(b.name).replace(/\s+/g, ' ').trim();
    if (n.length < 2) return bad('Give the category a name.');
    cat.name = n.slice(0, K.MAX_CAT_NAME);
  }
  if (b.code !== undefined) {
    const c = K.normCode(b.code);
    if (!K.isValidCode(c)) return bad('A code needs 4 to 12 letters or digits.');
    if (K.codeTaken(ko, c, cat.id)) return bad('Another category already uses that code.');
    cat.code = c;
  }
  // The TYPE decides how many players an entry carries, so changing it after
  // anyone has entered would leave half-formed pairs behind.
  if (b.type !== undefined && b.type !== cat.type) {
    if (K.activeOf(cat).length) return bad('Entries have already come in, so singles/doubles can’t change now.');
    cat.type = K.TYPES.includes(b.type) ? b.type : cat.type;
  }
  if (b.format !== undefined && K.FORMATS.includes(b.format)) cat.format = b.format;
  if (b.cap !== undefined) cat.cap = Math.min(K.MAX_CAP, Math.max(0, Math.round(Number(b.cap) || 0)));
  if (b.fee !== undefined) cat.fee = Math.min(K.MAX_FEE, Math.max(0, Math.round(Number(b.fee) || 0)));
  if (b.status !== undefined) {
    if (!K.CAT_STATUS.includes(b.status)) return bad('Unknown status.');
    if (b.status === 'open' && !cat.code) return bad('Give the category a code before opening entries.');
    cat.status = b.status;
  }
  Object.assign(cat, K.normalizeCategory(cat));
  pushAudit(state, { action: 'knockout.category.update', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, prevValue: prev, newValue: K.summary(cat) });
  return ok({ category: K.summary(cat) }, true);
}

function doDeleteCategory(state, body, now) {
  const ko = ensureKnockout(state);
  const cat = catById(ko, (body || {}).categoryId);
  if (!cat) return bad('Unknown category.');
  // Deleting a category throws away real people's entries, so it takes an
  // explicit confirm flag rather than one mis-tap.
  if (K.activeOf(cat).length && !(body || {}).confirm) {
    return bad('That category has ' + K.activeOf(cat).length + ' entries. Send confirm:true to delete it anyway.');
  }
  ko.categories = ko.categories.filter((c) => c.id !== cat.id);
  pushAudit(state, { action: 'knockout.category.delete', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, prevValue: { entrants: cat.entrants.length } });
  return ok({ removed: cat.id }, true);
}

function doNewCode(state, body, now, rand) {
  const ko = ensureKnockout(state);
  const cat = catById(ko, (body || {}).categoryId);
  if (!cat) return bad('Unknown category.');
  const prev = cat.code;
  cat.code = K.freshCode(ko, rand);
  pushAudit(state, { action: 'knockout.category.code', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, prevValue: prev, newValue: cat.code,
    note: 'Any poster showing the old code stops working.' });
  return ok({ code: cat.code }, true);
}

// ── admin: entrants ──────────────────────────────────────────────────

/** Walk-ins: an admin adds an entry at the desk, already confirmed. */
function doAddEntrant(state, body, now, rand) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  if (cat.draw) return bad('The draw is already made. Clear it first if you need to add an entry.');
  const v = K.validateEntry(b, { category: cat, requireIC: ko.event.requireIC && b.skipIC !== true });
  if (!v.ok) return bad(v.error);
  if (K.isDuplicateEntry(cat, v.clean.players) && !b.allowDuplicate) {
    return bad('That entry looks like one already in this category. Send allowDuplicate:true to add it anyway.');
  }
  const stored = v.clean.players.map((p) => {
    const sealed = sealIC(p.ic);
    return { name: p.name, phone: p.phone, club: p.club, icLast4: sealed.icLast4, icEnc: sealed.icEnc };
  });
  const entrant = K.normalizeEntrant({
    id: K.newId('ke', now, rand), at: now,
    status: b.status === 'pending' ? 'pending' : 'confirmed',
    paid: !!b.paid, paidAt: b.paid ? now : null, seed: null, note: b.note, players: stored,
  });
  cat.entrants.push(entrant);
  pushAudit(state, { action: 'knockout.entrant.add', admin: 'admin', at: now,
    target: { type: 'knockout', id: entrant.id, label: K.entrantLabel(entrant) }, newValue: { category: cat.name, status: entrant.status, paid: entrant.paid } });
  return ok({ entrant: K.adminEntrant(entrant) }, true);
}

function doSetEntrant(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  const e = entById(cat, b.entrantId);
  if (!e) return bad('Unknown entry.');
  const prev = { status: e.status, paid: e.paid, note: e.note };
  if (b.status !== undefined) {
    if (!K.ENT_STATUS.includes(b.status)) return bad('Unknown status.');
    // Confirming someone into a full category would push it over its own cap.
    if (b.status === 'confirmed' && e.status !== 'confirmed' && K.isFull(Object.assign({}, cat, { entrants: cat.entrants.filter((x) => x.id !== e.id) }))) {
      return bad('This category is already at its cap.');
    }
    e.status = b.status;
    // A withdrawal after the draw leaves a hole; say so rather than silently
    // rebuilding a bracket people are already standing next to.
    if (b.status === 'withdrawn' && cat.draw) e.note = (e.note ? e.note + ' · ' : '') + 'withdrew after the draw';
  }
  if (b.paid !== undefined) { e.paid = !!b.paid; e.paidAt = e.paid ? (e.paidAt || now) : null; }
  if (b.note !== undefined) e.note = String(b.note).replace(/\s+/g, ' ').trim().slice(0, 120);
  Object.assign(e, K.normalizeEntrant(e));
  pushAudit(state, { action: 'knockout.entrant.update', admin: 'admin', at: now,
    target: { type: 'knockout', id: e.id, label: K.entrantLabel(e) }, prevValue: prev, newValue: { status: e.status, paid: e.paid, note: e.note } });
  return ok({ entrant: K.adminEntrant(e), warnDraw: !!cat.draw }, true);
}

function doDeleteEntrant(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  const e = entById(cat, b.entrantId);
  if (!e) return bad('Unknown entry.');
  if (cat.draw && !b.confirm) return bad('That entry is in the draw. Withdraw it instead, or send confirm:true.');
  cat.entrants = cat.entrants.filter((x) => x.id !== e.id);
  pushAudit(state, { action: 'knockout.entrant.delete', admin: 'admin', at: now,
    target: { type: 'knockout', id: e.id, label: K.entrantLabel(e) }, prevValue: { category: cat.name, status: e.status } });
  return ok({ removed: e.id }, true);
}

/**
 * Decrypt ONE player's IC for an authenticated admin. Every call is audited
 * with whose number was read, because a reveal log is the only thing that makes
 * storing these numbers defensible.
 */
function doRevealIC(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  const e = entById(cat, b.entrantId);
  if (!e) return bad('Unknown entry.');
  const i = Math.max(0, Math.round(Number(b.playerIndex) || 0));
  const p = e.players[i];
  if (!p) return bad('Unknown player.');
  if (!p.icEnc) {
    return { status: 200, body: { ok: false, error: hasKey() ? 'No IC was stored for this player.' : 'IC encryption is not configured on this server, so nothing was stored.' }, changed: false };
  }
  let plain;
  try { plain = openIC(p.icEnc); }
  catch (err) {
    if (err instanceof NoKeyError || (err && err.noKey)) return { status: 200, body: { ok: false, error: 'The encryption key is not configured on this server.' }, changed: false };
    return { status: 200, body: { ok: false, error: 'That IC could not be decrypted.' }, changed: false };
  }
  pushAudit(state, { action: 'knockout.ic.reveal', admin: 'admin', at: now,
    target: { type: 'knockout', id: e.id, label: K.entrantLabel(e) },
    newValue: { player: p.name, category: cat.name },
    note: 'IC revealed to an admin' });
  // `changed` is true purely so the audit row persists.
  return { status: 200, body: { ok: true, ic: plain, player: p.name }, changed: true };
}

// ── admin: seeding + draws ───────────────────────────────────────────

/** Drag-to-reorder writes the full order; seed 1 is first. */
function doSeed(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  const order = Array.isArray(b.order) ? b.order.map(String) : null;
  if (!order) return bad('Send the seeding order.');
  const confirmed = K.confirmedOf(cat).map((e) => e.id);
  const set = new Set(order);
  if (set.size !== order.length) return bad('That order lists someone twice.');
  if (order.length !== confirmed.length || !confirmed.every((id) => set.has(id))) {
    return bad('The seeding order must list every confirmed entry exactly once.');
  }
  order.forEach((id, i) => { const e = entById(cat, id); if (e) e.seed = i + 1; });
  pushAudit(state, { action: 'knockout.seed', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, newValue: { seeds: order.length } });
  return ok({ seeded: order.length, stale: !!cat.draw }, true);
}

function doGenerateDraw(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  // Regenerating throws away every score already entered, so it is explicit.
  if (cat.draw && !b.confirm) {
    const played = Object.keys(cat.draw.results || {}).length;
    return bad(played ? 'This draw already has ' + played + ' result' + (played === 1 ? '' : 's') + '. Send confirm:true to rebuild it from scratch.' : 'A draw already exists. Send confirm:true to rebuild it.');
  }
  const built = K.buildDraw(cat, { nowMs: now, thirdPlace: b.thirdPlace !== false, finalAfterRR: b.finalAfterRR !== false });
  if (!built.ok) return bad(built.error);
  cat.draw = built.draw;
  cat.status = 'drawn';
  const sum = K.summary(cat);
  pushAudit(state, { action: 'knockout.draw.generate', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name },
    newValue: { format: built.draw.format, entrants: sum.confirmed, size: sum.size, byes: sum.byes } });
  return ok({ view: K.viewOf(cat), summary: sum }, true);
}

function doClearDraw(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  if (!cat.draw) return bad('There is no draw to clear.');
  const played = Object.keys(cat.draw.results || {}).length;
  if (played && !b.confirm) return bad('That draw has ' + played + ' result' + (played === 1 ? '' : 's') + '. Send confirm:true to clear it.');
  cat.draw = null;
  cat.status = 'open';
  pushAudit(state, { action: 'knockout.draw.clear', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, prevValue: { results: played } });
  return ok({ view: K.viewOf(cat) }, true);
}

// ── admin: results ───────────────────────────────────────────────────

function doSetResult(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  if (!cat.draw) return bad('There is no draw yet.');
  const live = K.effectiveDraw(cat);
  const v = K.validateResult(live, b.matchId, b);
  if (!v.ok) return bad(v.error);
  const matchId = String(b.matchId);
  const prior = cat.draw.results[matchId];
  // Changing a decided match unwinds everything that followed from it. Say
  // exactly how much before doing it, rather than after.
  if (prior && prior.winner && prior.winner !== v.clean.winner) {
    const lost = K.downstreamResults(live, matchId, v.clean.winner);
    if (lost.length && !b.confirm) {
      return bad('Changing that result clears ' + lost.length + ' later result' + (lost.length === 1 ? '' : 's') + '. Send confirm:true to do it.');
    }
    for (const id of lost) delete cat.draw.results[id];
  }
  cat.draw.results[matchId] = { winner: v.clean.winner, score: v.clean.score, at: now };
  const view = K.viewOf(cat);
  // The status follows the bracket in BOTH directions: correcting a result that
  // un-decides the final must take the category back out of "done", or a screen
  // somewhere keeps claiming there is a champion.
  if (cat.status === 'done' || cat.status === 'drawn') cat.status = view.complete ? 'done' : 'drawn';
  pushAudit(state, { action: 'knockout.result', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name },
    prevValue: prior || null,
    newValue: { match: matchId, winner: K.entrantLabel(entById(cat, v.clean.winner)), score: v.clean.score } });
  return ok({ view, complete: view.complete, champion: view.championLabel || '' }, true);
}

function doClearResult(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  if (!cat.draw) return bad('There is no draw yet.');
  const matchId = String(b.matchId || '');
  if (!cat.draw.results[matchId]) return bad('That match has no result to clear.');
  const live = K.effectiveDraw(cat);
  const lost = K.downstreamResults(live, matchId, '');
  if (lost.length && !b.confirm) {
    return bad('Clearing that also clears ' + lost.length + ' later result' + (lost.length === 1 ? '' : 's') + '. Send confirm:true to do it.');
  }
  const prior = cat.draw.results[matchId];
  delete cat.draw.results[matchId];
  for (const id of lost) delete cat.draw.results[id];
  if (cat.status === 'done') cat.status = 'drawn';
  pushAudit(state, { action: 'knockout.result.clear', admin: 'admin', at: now,
    target: { type: 'knockout', id: cat.id, label: cat.name }, prevValue: prior, newValue: { alsoCleared: lost.length } });
  return ok({ view: K.viewOf(cat) }, true);
}

/** Put a match on a court (or take it off). This is the "on court now" strip. */
function doSetCourt(state, body, now) {
  const ko = ensureKnockout(state);
  const b = body || {};
  const cat = catById(ko, b.categoryId);
  if (!cat) return bad('Unknown category.');
  if (!cat.draw) return bad('There is no draw yet.');
  const matchId = String(b.matchId || '');
  const m = cat.draw.matches.find((x) => x.id === matchId);
  if (!m) return bad('Unknown match.');
  const court = b.court == null || b.court === '' ? null : String(b.court).trim().slice(0, 12);
  m.court = court;
  return ok({ matchId, court }, true);
}

// ── admin: the whole picture ─────────────────────────────────────────

/**
 * Everything the admin tab renders, with ICs masked to their last four. The
 * full numbers need `knockoutRevealIC`, one player at a time, audited.
 */
function doGetAdmin(state) {
  const ko = ensureKnockout(state);
  return {
    status: 200,
    body: {
      ok: true,
      event: ko.event,
      settings: knockoutSettings(),
      categories: ko.categories.map((c) => Object.assign(K.summary(c), {
        cap: c.cap, fee: c.fee, formatSetting: c.format,
        spacesLeft: K.spacesLeft(c),
        entrants: c.entrants.map(K.adminEntrant),
        view: K.viewOf(c),
      })),
      todo: K.todoCount(ko),
    },
    changed: false,
  };
}

// ── dispatchers ──────────────────────────────────────────────────────

/** Public (code-gated, no admin password). Returns the handler contract. */
function handleKnockoutPublicAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return bad();
    const o = opts || {};
    const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
    const rand = typeof o.rand === 'function' ? o.rand : Math.random;
    ensureKnockout(state);
    switch (body && body.action) {
      case 'knockoutLookup':      return doLookup(state, body);
      case 'submitKnockoutEntry': return doSubmitEntry(state, body, now, rand);
      default:                    return bad('Unknown action.');
    }
  } catch (e) {
    return bad();
  }
}

/** Admin (password already checked by api/state.js). */
function handleKnockoutAdminAction(state, body, opts) {
  try {
    if (!state || typeof state !== 'object') return bad();
    const o = opts || {};
    const now = o.nowMs != null ? Number(o.nowMs) : Date.now();
    const rand = typeof o.rand === 'function' ? o.rand : Math.random;
    ensureKnockout(state);
    switch (body && body.action) {
      case 'knockoutGetAdmin':       return doGetAdmin(state);
      case 'knockoutSetEvent':       return doSetEvent(state, body, now);
      case 'knockoutAddCategory':    return doAddCategory(state, body, now, rand);
      case 'knockoutUpdateCategory': return doUpdateCategory(state, body, now);
      case 'knockoutDeleteCategory': return doDeleteCategory(state, body, now);
      case 'knockoutNewCode':        return doNewCode(state, body, now, rand);
      case 'knockoutAddEntrant':     return doAddEntrant(state, body, now, rand);
      case 'knockoutSetEntrant':     return doSetEntrant(state, body, now);
      case 'knockoutDeleteEntrant':  return doDeleteEntrant(state, body, now);
      case 'knockoutRevealIC':       return doRevealIC(state, body, now);
      case 'knockoutSeed':           return doSeed(state, body, now);
      case 'knockoutGenerateDraw':   return doGenerateDraw(state, body, now);
      case 'knockoutClearDraw':      return doClearDraw(state, body, now);
      case 'knockoutSetResult':      return doSetResult(state, body, now);
      case 'knockoutClearResult':    return doClearResult(state, body, now);
      case 'knockoutSetCourt':       return doSetCourt(state, body, now);
      default:                       return bad('Unknown action.');
    }
  } catch (e) {
    return bad();
  }
}

module.exports = {
  KNOCKOUT_PUBLIC_ACTIONS, KNOCKOUT_ADMIN_ACTIONS, MAX_REVEALS_LOGGED,
  ensureKnockout, sealIC, openIC, knockoutSettings,
  handleKnockoutPublicAction, handleKnockoutAdminAction,
};
