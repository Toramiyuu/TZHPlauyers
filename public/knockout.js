/*
 * knockout.js — pure logic for the TZH open competition (the "Knockout" system).
 * Loaded in the browser via <script src> (window.Knockout) and required by
 * lib/knockout.js + the Node tests. No DOM, no dependencies, no clock and no
 * randomness of its own: `nowMs` and `rand` are ALWAYS injected, so every
 * function is deterministic under test.
 *
 * WHAT THIS IS
 *   An open, public competition that anyone can enter, not just the regulars who
 *   come to the social games. An admin creates an event with one or more
 *   CATEGORIES ("Men's Doubles Under 40", "Mixed Doubles Open", ...). Each
 *   category carries its own PUBLIC CODE, which is meant to be printed on a
 *   poster or posted on Instagram: entering it on the public site opens the
 *   registration form for that category. For doubles, ONE person fills in both
 *   players' details (name / phone / IC / club), exactly like the reference
 *   tournaments this was modelled on.
 *
 * FORMAT (decided 2026-09-19)
 *   Single elimination is the primary format. A category with AUTO_RR_MAX or
 *   fewer confirmed entrants runs a ROUND ROBIN instead, because a 5-team
 *   knockout hands out 3 byes and sends a team home after one match. The two
 *   top-placed entrants then contest a final. This mirrors what the reference
 *   organiser did with their 5-team U14 doubles category.
 *
 * DRAWS ARE DERIVED, NOT MUTATED
 *   A draw stores only its SKELETON (the slot order and the match graph) plus a
 *   `results` map of matchId -> { winner, score }. `resolveDraw()` recomputes
 *   every participant from those two things on demand. That means correcting a
 *   score the admin mis-typed automatically invalidates everything downstream of
 *   it: a stale later result whose participants no longer match is simply
 *   ignored rather than leaving a ghost name in a later round. There is no
 *   "advance the winner" mutation anywhere, so a bracket can never disagree
 *   with itself.
 *
 * PRIVACY
 *   IC / passport numbers NEVER live in this module's output for public use.
 *   `publicKnockout()` is the only projection the unauthenticated GET may serve:
 *   it drops phone, IC (both the encrypted blob and the last four) and every
 *   entrant who is not confirmed. Encryption itself is lib/knockout.js's job
 *   (AES-256-GCM via lib/crypto.js); this module only ever sees `icLast4`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.Knockout = api;                                             // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── limits (the ONLY place these live) ───────────────────────────────
  const MAX_CATEGORIES   = 16;
  const MAX_ENTRANTS     = 128;  // per category
  const MAX_PER_SUBMIT   = 8;    // entries one person may add in a single submission
  const AUTO_RR_MAX      = 5;    // this many confirmed entrants or fewer -> round robin
  const MIN_DRAW         = 2;
  const MIN_NAME         = 2,  MAX_NAME  = 60;
  const MIN_PHONE_DIGITS = 7,  MAX_PHONE_DIGITS = 15;
  const MIN_IC           = 5,  MAX_IC    = 24;
  const MAX_CLUB         = 60;
  const MAX_CAT_NAME     = 60;
  const MAX_EVENT_NAME   = 80;
  const MAX_VENUE        = 80;
  const MAX_SCORE        = 40;
  const MAX_FEE          = 1000;
  const MAX_CAP          = MAX_ENTRANTS;

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — read aloud off a poster
  const CODE_LEN      = 6;
  const FREE_AGENT    = 'Free Agent';

  const TYPES       = ['singles', 'doubles'];
  const FORMATS     = ['auto', 'knockout', 'roundrobin'];
  const CAT_STATUS  = ['setup', 'open', 'closed', 'drawn', 'done'];
  const ENT_STATUS  = ['pending', 'confirmed', 'withdrawn'];

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ── small helpers ────────────────────────────────────────────────────
  const isStr  = (v) => typeof v === 'string';
  const num    = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clean  = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || MAX_NAME);
  const isISO  = (s) => isStr(s) && ISO_RE.test(s);
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const arr    = (v) => (Array.isArray(v) ? v : []);
  const obj    = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  /** IC/passport stripped to the characters we compare and store. */
  function normIC(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_IC); }
  /** The ONLY part of an IC that may ever be shown, even to an admin, before a reveal. */
  function icLast4(v) { const s = normIC(v); return s ? s.slice(-4) : ''; }
  /** Admin list display: "••••1234". Never the full number. */
  function maskIC(last4) { const s = String(last4 || '').slice(-4); return s ? '••••' + s : ''; }

  /** Deterministic id. `rand` is injected (Math.random in production). */
  function newId(prefix, nowMs, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    return String(prefix || 'x') + Number(nowMs || 0).toString(36) + r().toString(36).slice(2, 7);
  }

  /** A public category code: 6 unambiguous characters. Collisions are caller-checked. */
  function genCode(rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
    return out;
  }
  /** Codes are compared case-insensitively and ignoring spaces/dashes people add. */
  function normCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isValidCode(v) { const c = normCode(v); return c.length >= 4 && c.length <= 12; }

  // ── state shape ──────────────────────────────────────────────────────

  function emptyKnockout() {
    return { event: { name: '', date: '', venue: '', regOpen: false, published: false }, categories: [] };
  }

  function normalizeEvent(e) {
    const s = obj(e);
    return {
      name:      clean(s.name, MAX_EVENT_NAME),
      date:      isISO(s.date) ? s.date : '',
      venue:     clean(s.venue, MAX_VENUE),
      regOpen:   !!s.regOpen,
      published: !!s.published,
      // Whether registration demands an IC/passport. Default ON (age-graded
      // categories need it); an admin can turn it off for an event that does
      // not, because the safest personal data is the kind never collected.
      requireIC: s.requireIC !== false,
      // Shown on the Payment step: how the entry fee is actually paid.
      payTo:     clean(s.payTo, 160),
    };
  }

  function normalizePlayer(p) {
    const s = obj(p);
    const club = clean(s.club, MAX_CLUB);
    return {
      name:   clean(s.name, MAX_NAME),
      phone:  clean(s.phone, MAX_PHONE_DIGITS + 8),
      club:   club || FREE_AGENT,
      icLast4: icLast4(s.icLast4 || ''),
      // Encrypted blob ({iv,ct,tag,k}) written by lib/knockout.js, or null when
      // no key is configured. NEVER a plaintext IC.
      icEnc:  (s.icEnc && typeof s.icEnc === 'object' && s.icEnc.ct) ? s.icEnc : null,
    };
  }

  function normalizeEntrant(e) {
    const s = obj(e);
    const players = arr(s.players).slice(0, 2).map(normalizePlayer);
    return {
      id:      clean(s.id, 40) || '',
      at:      num(s.at),
      status:  ENT_STATUS.includes(s.status) ? s.status : 'pending',
      paid:    !!s.paid,
      paidAt:  s.paidAt == null ? null : num(s.paidAt),
      seed:    s.seed == null ? null : Math.max(0, Math.round(num(s.seed))) || null,
      note:    clean(s.note, 120),
      players,
    };
  }

  function normalizeCategory(c) {
    const s = obj(c);
    const type = TYPES.includes(s.type) ? s.type : 'doubles';
    const entrants = arr(s.entrants).slice(0, MAX_ENTRANTS).map(normalizeEntrant).filter((e) => e.id);
    return {
      id:     clean(s.id, 40) || '',
      name:   clean(s.name, MAX_CAT_NAME),
      type,
      code:   normCode(s.code),
      format: FORMATS.includes(s.format) ? s.format : 'auto',
      cap:    Math.min(MAX_CAP, Math.max(0, Math.round(num(s.cap)))),   // 0 = no cap
      fee:    Math.min(MAX_FEE, Math.max(0, Math.round(num(s.fee)))),
      status: CAT_STATUS.includes(s.status) ? s.status : 'setup',
      entrants,
      draw:   s.draw ? normalizeDraw(s.draw) : null,
    };
  }

  function normalizeDraw(d) {
    const s = obj(d);
    const format = s.format === 'roundrobin' ? 'roundrobin' : 'knockout';
    const results = {};
    const raw = obj(s.results);
    for (const k of Object.keys(raw)) {
      const r = obj(raw[k]);
      const w = clean(r.winner, 40);
      if (!w) continue;
      results[clean(k, 40)] = { winner: w, score: clean(r.score, MAX_SCORE), at: num(r.at) };
    }
    return {
      format,
      size:        Math.max(0, Math.round(num(s.size))),
      slots:       arr(s.slots).map((x) => (x == null ? null : clean(x, 40) || null)),
      matches:     arr(s.matches).map(normalizeMatchSkeleton),
      results,
      thirdPlace:  !!s.thirdPlace,
      finalAfterRR: !!s.finalAfterRR,
      generatedAt: num(s.generatedAt),
    };
  }

  function normalizeMatchSkeleton(m) {
    const s = obj(m);
    return {
      id:    clean(s.id, 40),
      round: Math.max(0, Math.round(num(s.round))),
      idx:   Math.max(0, Math.round(num(s.idx))),
      aFrom: s.aFrom ? clean(s.aFrom, 40) : null,   // matchId whose WINNER fills slot A
      bFrom: s.bFrom ? clean(s.bFrom, 40) : null,
      aFromLoser: s.aFromLoser ? clean(s.aFromLoser, 40) : null, // third-place playoff
      bFromLoser: s.bFromLoser ? clean(s.bFromLoser, 40) : null,
      aSlot: s.aSlot == null ? null : Math.max(0, Math.round(num(s.aSlot))), // seeded slot index
      bSlot: s.bSlot == null ? null : Math.max(0, Math.round(num(s.bSlot))),
      aId:   s.aId ? clean(s.aId, 40) : null,   // round robin: fixed participants
      bId:   s.bId ? clean(s.bId, 40) : null,
      label: clean(s.label, 40),
      court: s.court == null ? null : clean(s.court, 12),
    };
  }

  /** Repair any saved blob to the current shape. Additive, never throws. */
  function normalize(ko) {
    const s = obj(ko);
    const out = { event: normalizeEvent(s.event), categories: arr(s.categories).slice(0, MAX_CATEGORIES).map(normalizeCategory).filter((c) => c.id) };
    // Codes must be unique across categories or a code lookup is ambiguous.
    const seen = new Set();
    for (const c of out.categories) {
      if (c.code && seen.has(c.code)) c.code = '';
      if (c.code) seen.add(c.code);
    }
    return out;
  }

  // ── lookups ──────────────────────────────────────────────────────────

  function categoriesOf(ko) { return normalize(ko).categories; }
  function findCategory(ko, id) { return categoriesOf(ko).find((c) => c.id === String(id || '')) || null; }

  /**
   * Resolve a public code typed on the sign-up screen. Only a category that is
   * OPEN and whose event has registration open can be entered, so an old poster
   * cannot reopen a finished draw.
   */
  function findByCode(ko, code) {
    const k = normalize(ko);
    const c = normCode(code);
    if (!c) return null;
    const cat = k.categories.find((x) => x.code && x.code === c);
    if (!cat) return null;
    return cat;
  }

  function codeTaken(ko, code, exceptId) {
    const c = normCode(code);
    return categoriesOf(ko).some((x) => x.code === c && x.id !== String(exceptId || ''));
  }

  /** A fresh code that no category is already using. */
  function freshCode(ko, rand) {
    for (let i = 0; i < 40; i++) { const c = genCode(rand); if (!codeTaken(ko, c)) return c; }
    return genCode(rand);
  }

  // ── entrants ─────────────────────────────────────────────────────────

  const playersNeeded = (type) => (type === 'singles' ? 1 : 2);

  /** "Alex Tan & Wei Ming" for doubles, "Alex Tan" for singles. */
  function entrantLabel(entrant) {
    const ps = arr(obj(entrant).players).map((p) => clean(obj(p).name, MAX_NAME)).filter(Boolean);
    return ps.length ? ps.join(' & ') : 'TBC';
  }

  /** The club shown under a bracket label, or '' when everyone is a free agent. */
  function entrantClub(entrant) {
    const cs = arr(obj(entrant).players).map((p) => clean(obj(p).club, MAX_CLUB)).filter((c) => c && c !== FREE_AGENT);
    return [...new Set(cs)].join(' / ');
  }

  /**
   * The display label for an entrant in EITHER shape. The stored entrant carries
   * a players array; the public projection carries a precomputed `label` and no
   * players at all, because phone numbers and ICs live on those player objects.
   * Everything that puts a name on a screen goes through these two, so a bracket
   * renders identically whether it was built from the private or public shape.
   */
  function labelOf(entrant) {
    const e = obj(entrant);
    const pre = clean(e.label, MAX_NAME * 2 + 3);
    return pre || entrantLabel(e);
  }
  function clubOf(entrant) {
    const e = obj(entrant);
    if (e.club !== undefined) return clean(e.club, MAX_CLUB * 2 + 3);
    return entrantClub(e);
  }

  const confirmedOf = (cat) => arr(obj(cat).entrants).filter((e) => e && e.status === 'confirmed');
  const pendingOf   = (cat) => arr(obj(cat).entrants).filter((e) => e && e.status === 'pending');
  const activeOf    = (cat) => arr(obj(cat).entrants).filter((e) => e && e.status !== 'withdrawn');

  /** Cap counts everyone who has not withdrawn, so pending entries hold a place. */
  function isFull(cat) {
    const c = obj(cat);
    const cap = Math.max(0, Math.round(num(c.cap)));
    return cap > 0 && activeOf(c).length >= cap;
  }
  function spacesLeft(cat) {
    const c = obj(cat);
    const cap = Math.max(0, Math.round(num(c.cap)));
    return cap > 0 ? Math.max(0, cap - activeOf(c).length) : null; // null = uncapped
  }

  // ── registration validation ──────────────────────────────────────────

  function bad(error) { return { ok: false, error, clean: null }; }

  /**
   * Validate ONE entry (one singles player, or one doubles pair) against a
   * category. `requireIC` is a server setting so the club can run an event that
   * collects no ID at all. Returns sanitized players — never the caller's object.
   */
  function validateEntry(input, opts) {
    const o = obj(opts);
    const cat = obj(o.category);
    const need = playersNeeded(cat.type);
    const requireIC = o.requireIC !== false;
    const raw = arr(obj(input).players);
    if (raw.length !== need) {
      return bad(need === 2 ? 'Doubles needs both players’ details.' : 'Enter the player’s details.');
    }
    const out = [];
    for (let i = 0; i < need; i++) {
      const p = obj(raw[i]);
      const who = need === 2 ? ('Player ' + (i + 1) + ': ') : '';
      const name = clean(p.name, MAX_NAME);
      if (name.length < MIN_NAME) return bad(who + 'please enter a full name.');
      const ph = digits(p.phone);
      if (ph.length < MIN_PHONE_DIGITS || ph.length > MAX_PHONE_DIGITS) return bad(who + 'please enter a valid contact number.');
      const ic = normIC(p.ic);
      if (requireIC && (ic.length < MIN_IC || ic.length > MAX_IC)) return bad(who + 'please enter a valid IC or passport number.');
      const club = clean(p.club, MAX_CLUB) || FREE_AGENT;
      // `ic` is handed to lib/knockout.js, which encrypts it and keeps only the
      // last four here. It must never be persisted as it stands.
      out.push({ name, phone: ph, club, ic });
    }
    // The same person twice is nearly always a typo, and it breaks the label.
    if (need === 2 && out[0].name.toLowerCase() === out[1].name.toLowerCase()) {
      return bad('Both players have the same name. Please check.');
    }
    if (need === 2 && out[0].ic && out[0].ic === out[1].ic) {
      return bad('Both players have the same IC number. Please check.');
    }
    return { ok: true, error: '', clean: { players: out } };
  }

  /** Validate a whole submission: a code, and 1..MAX_PER_SUBMIT entries for it. */
  function validateSubmission(input, opts) {
    const o = obj(opts);
    const body = obj(input);
    const cat = obj(o.category);
    if (!cat.id) return bad('That code doesn’t match an open category.');
    if (cat.status !== 'open') return bad('Entries for this category are closed.');
    if (o.regOpen === false) return bad('Entries are closed.');
    const entries = arr(body.entries);
    if (!entries.length) return bad('Please complete the form.');
    if (entries.length > MAX_PER_SUBMIT) return bad('You can enter up to ' + MAX_PER_SUBMIT + ' at a time.');
    const left = spacesLeft(cat);
    if (left !== null && entries.length > left) {
      return bad(left === 0 ? 'This category is full.' : 'Only ' + left + ' place' + (left === 1 ? '' : 's') + ' left in this category.');
    }
    const out = [];
    for (const e of entries) {
      const v = validateEntry(e, o);
      if (!v.ok) return v;
      out.push(v.clean);
    }
    // A pair already entered in this category (same IC on both sides) is a double submit.
    return { ok: true, error: '', clean: { categoryId: cat.id, entries: out } };
  }

  /**
   * True when this entry looks like one already in the category — a double
   * submit from someone who tapped Next twice, or a pair entered by both of its
   * players. Only the LAST FOUR of an IC are ever stored, so the comparison uses
   * last-four plus name: strong enough to catch a real double submit, and
   * deliberately not treated as proof of identity anywhere.
   */
  function isDuplicateEntry(cat, players) {
    const keyOf = (p) => {
      const o = obj(p);
      const four = icLast4(o.ic || o.icLast4);
      const nm = clean(o.name, MAX_NAME).toLowerCase();
      return four ? 'ic:' + four + '/' + nm : 'nm:' + nm;
    };
    const want = arr(players).map(keyOf).sort().join('|');
    if (!want) return false;
    return activeOf(cat).some((e) => arr(e.players).map(keyOf).sort().join('|') === want);
  }

  // ── format choice ────────────────────────────────────────────────────

  /**
   * Which format a category will actually run. 'auto' switches to a round robin
   * at AUTO_RR_MAX confirmed entrants or fewer, because a knockout that small
   * is mostly byes.
   */
  function effectiveFormat(cat, count) {
    const c = obj(cat);
    const n = count == null ? confirmedOf(c).length : Math.max(0, Math.round(num(count)));
    if (c.format === 'knockout') return 'knockout';
    if (c.format === 'roundrobin') return 'roundrobin';
    return n <= AUTO_RR_MAX ? 'roundrobin' : 'knockout';
  }

  function formatLabel(f) { return f === 'roundrobin' ? 'Round robin' : 'Knockout'; }

  // ── seeding ──────────────────────────────────────────────────────────

  /** Smallest power of two that holds n (min 2). 20 -> 32, 5 -> 8, 2 -> 2. */
  function bracketSize(n) {
    const c = Math.max(MIN_DRAW, Math.round(num(n)));
    let s = MIN_DRAW;
    while (s < c) s *= 2;
    return s;
  }

  /**
   * Standard bracket seeding order for `size` slots: the list of SEED NUMBERS in
   * slot order, built so seed 1 and seed 2 can only meet in the final and every
   * round pairs the strongest remaining against the weakest remaining.
   * size 4 -> [1,4,3,2]; size 8 -> [1,8,5,4,3,6,7,2].
   */
  function seedOrder(size) {
    let order = [1];
    while (order.length < size) {
      const n = order.length * 2;
      const next = [];
      for (const s of order) { next.push(s); next.push(n + 1 - s); }
      order = next;
    }
    return order;
  }

  /**
   * Place entrants into bracket slots. `ids` is in SEEDED order (strongest
   * first), so ids[0] is seed 1. Slots whose seed number is beyond the field are
   * byes (null), which is how 20 entrants in a 32 draw give the top 12 a bye.
   */
  function seedSlots(ids, size) {
    const list = arr(ids).map(String);
    const s = bracketSize(size || list.length);
    return seedOrder(s).map((seedNo) => (seedNo <= list.length ? list[seedNo - 1] : null));
  }

  function byeCount(n) { return bracketSize(n) - Math.max(MIN_DRAW, Math.round(num(n))); }

  /** "Round of 32" / "Quarter-finals" / "Semi-finals" / "Final". */
  function roundName(size, round) {
    const left = Math.round(num(size)) / Math.pow(2, Math.max(0, Math.round(num(round))) - 1);
    if (left <= 2) return 'Final';
    if (left === 4) return 'Semi-finals';
    if (left === 8) return 'Quarter-finals';
    return 'Round of ' + left;
  }

  function roundCount(size) { return Math.max(1, Math.round(Math.log2(Math.max(MIN_DRAW, Math.round(num(size)))))); }

  // ── building draws ───────────────────────────────────────────────────

  /**
   * Single-elimination skeleton. Round 1 reads the seeded slots; every later
   * round reads the winners of the two matches below it. `thirdPlace` adds one
   * extra match fed by the two SEMI-FINAL LOSERS.
   */
  function buildKnockoutDraw(ids, opts) {
    const o = obj(opts);
    const list = arr(ids).map(String).filter(Boolean);
    const size = bracketSize(list.length);
    const slots = seedSlots(list, size);
    const rounds = roundCount(size);
    const matches = [];
    let prev = [];
    for (let r = 1; r <= rounds; r++) {
      const count = size / Math.pow(2, r);
      const here = [];
      for (let i = 0; i < count; i++) {
        const m = {
          id: 'r' + r + 'm' + (i + 1), round: r, idx: i,
          aFrom: null, bFrom: null, aFromLoser: null, bFromLoser: null,
          aSlot: null, bSlot: null, aId: null, bId: null,
          label: roundName(size, r), court: null,
        };
        if (r === 1) { m.aSlot = i * 2; m.bSlot = i * 2 + 1; }
        else { m.aFrom = prev[i * 2].id; m.bFrom = prev[i * 2 + 1].id; }
        here.push(m);
        matches.push(m);
      }
      prev = here;
    }
    const thirdPlace = !!o.thirdPlace && rounds >= 2;
    if (thirdPlace) {
      const semis = matches.filter((m) => m.round === rounds - 1);
      matches.push({
        id: 'bronze', round: rounds, idx: 1,
        aFrom: null, bFrom: null, aFromLoser: semis[0].id, bFromLoser: semis[1].id,
        aSlot: null, bSlot: null, aId: null, bId: null,
        label: 'Third place', court: null,
      });
    }
    return { format: 'knockout', size, slots, matches, results: {}, thirdPlace, finalAfterRR: false, generatedAt: num(o.nowMs) };
  }

  /**
   * Round robin: every entrant plays every other once (circle method, so each
   * round is a clean set of simultaneous matches). With `finalAfterRR`, the top
   * two in the table then contest a final, which is what gives a small category
   * the same finish as a bracket.
   */
  function buildRoundRobinDraw(ids, opts) {
    const o = obj(opts);
    const list = arr(ids).map(String).filter(Boolean);
    const n = list.length;
    const pad = n % 2 === 1 ? list.concat([null]) : list.slice();
    const size = pad.length;
    const matches = [];
    let seq = 0;
    for (let r = 0; r < size - 1; r++) {
      for (let i = 0; i < size / 2; i++) {
        const a = pad[i];
        const b = pad[size - 1 - i];
        if (!a || !b) continue; // the odd entrant's bye round
        seq++;
        matches.push({
          id: 'rr' + seq, round: r + 1, idx: i,
          aFrom: null, bFrom: null, aFromLoser: null, bFromLoser: null,
          aSlot: null, bSlot: null, aId: a, bId: b,
          label: 'Round ' + (r + 1), court: null,
        });
      }
      // rotate, holding the first entry fixed
      pad.splice(1, 0, pad.pop());
    }
    const finalAfterRR = o.finalAfterRR !== false && n >= 3;
    if (finalAfterRR) {
      matches.push({
        id: 'rrfinal', round: size, idx: 0,
        aFrom: null, bFrom: null, aFromLoser: null, bFromLoser: null,
        aSlot: null, bSlot: null, aId: null, bId: null,
        label: 'Final', court: null,
      });
    }
    return { format: 'roundrobin', size: n, slots: list.slice(), matches, results: {}, thirdPlace: false, finalAfterRR, generatedAt: num(o.nowMs) };
  }

  /**
   * Build the draw for a category from its CONFIRMED entrants. Seeding order is
   * the admin's (entrant.seed ascending, unseeded last in list order), which is
   * what drag-to-reorder writes.
   */
  function buildDraw(cat, opts) {
    const c = normalizeCategory(cat);
    const o = obj(opts);
    const list = confirmedOf(c).slice().sort((a, b) => {
      const sa = a.seed == null ? Infinity : a.seed;
      const sb = b.seed == null ? Infinity : b.seed;
      if (sa !== sb) return sa - sb;
      return a.at - b.at;
    });
    const ids = list.map((e) => e.id);
    if (ids.length < MIN_DRAW) return { ok: false, error: 'Need at least ' + MIN_DRAW + ' confirmed entries to make a draw.', draw: null };
    const fmt = effectiveFormat(c, ids.length);
    const draw = fmt === 'roundrobin'
      ? buildRoundRobinDraw(ids, { nowMs: o.nowMs, finalAfterRR: o.finalAfterRR })
      : buildKnockoutDraw(ids, { nowMs: o.nowMs, thirdPlace: o.thirdPlace !== false });
    return { ok: true, error: '', draw };
  }

  // ── resolving a draw ─────────────────────────────────────────────────

  function winnerOf(results, matchId) { const r = obj(obj(results)[matchId]); return r.winner || null; }

  /**
   * Turn a skeleton + results into the live bracket. Every participant is
   * DERIVED, so a corrected result silently drops anything downstream that no
   * longer follows from it.
   *
   * Each returned match carries:
   *   a / b        entrant ids (null = not decided yet)
   *   bye          one side is empty and the other walks through
   *   winner/loser resolved from `results`, ignoring stale rows
   *   state        'waiting' | 'ready' | 'done'
   */
  function resolveDraw(draw) {
    const d = normalizeDraw(draw);
    const byId = {};
    for (const m of d.matches) byId[m.id] = m;
    const out = [];
    const res = {};
    // Matches are built in dependency order (round 1 first), so one pass is enough.
    for (const m of d.matches) {
      const a = m.aId != null ? m.aId
        : m.aSlot != null ? (d.slots[m.aSlot] || null)
        : m.aFrom ? (res[m.aFrom] ? res[m.aFrom].winner : null)
        : m.aFromLoser ? (res[m.aFromLoser] ? res[m.aFromLoser].loser : null)
        : null;
      const b = m.bId != null ? m.bId
        : m.bSlot != null ? (d.slots[m.bSlot] || null)
        : m.bFrom ? (res[m.bFrom] ? res[m.bFrom].winner : null)
        : m.bFromLoser ? (res[m.bFromLoser] ? res[m.bFromLoser].loser : null)
        : null;
      // A first-round slot with nobody opposite is a bye: that side walks through.
      const isBye = m.round === 1 && d.format === 'knockout' && ((a && !b) || (b && !a));
      const stored = obj(d.results[m.id]);
      let winner = null, loser = null, score = '', at = 0;
      if (isBye) {
        winner = a || b; loser = null; score = ''; at = 0;
      } else if (stored.winner && (stored.winner === a || stored.winner === b)) {
        winner = stored.winner;
        loser = stored.winner === a ? b : a;
        score = stored.score || '';
        at = num(stored.at);
      }
      const ready = !!(a && b) && !winner;
      const state = winner ? 'done' : (ready ? 'ready' : 'waiting');
      const row = { id: m.id, round: m.round, idx: m.idx, label: m.label, court: m.court || null, a, b, bye: isBye, winner, loser, score, at, state };
      res[m.id] = row;
      out.push(row);
    }
    // The champion is the winner of the last non-bronze match.
    const real = out.filter((m) => m.id !== 'bronze');
    const last = real.length ? real[real.length - 1] : null;
    const champion = last && last.winner ? last.winner : null;
    const runnerUp = last && last.winner ? last.loser : null;
    const bronze = out.find((m) => m.id === 'bronze') || null;
    return {
      format: d.format, size: d.size, matches: out, byId: res,
      champion, runnerUp,
      third: bronze && bronze.winner ? bronze.winner : null,
      complete: !!champion,
      rounds: Math.max(0, ...out.map((m) => m.round)),
      thirdPlace: d.thirdPlace, finalAfterRR: d.finalAfterRR,
    };
  }

  /** The matches an admin can enter a score for right now, in play order. */
  function readyMatches(draw) { return resolveDraw(draw).matches.filter((m) => m.state === 'ready'); }
  /** Matches still waiting on an earlier result — the "up next" strip. */
  function upcomingMatches(draw) { return resolveDraw(draw).matches.filter((m) => m.state === 'waiting'); }

  // ── scores ───────────────────────────────────────────────────────────

  /**
   * Parse a badminton score like "21-15, 19-21, 21-17" into games. Tolerant:
   * anything unparseable comes back ok:false and is still stored as free text,
   * because the WINNER is recorded explicitly, never inferred from the score.
   */
  function parseScore(text) {
    const s = clean(text, MAX_SCORE);
    if (!s) return { ok: false, games: [], setsA: 0, setsB: 0, ptsA: 0, ptsB: 0 };
    const games = [];
    for (const part of s.split(/[,;/]+/)) {
      const m = String(part).trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
      if (!m) return { ok: false, games: [], setsA: 0, setsB: 0, ptsA: 0, ptsB: 0 };
      games.push([Number(m[1]), Number(m[2])]);
    }
    if (!games.length) return { ok: false, games: [], setsA: 0, setsB: 0, ptsA: 0, ptsB: 0 };
    let setsA = 0, setsB = 0, ptsA = 0, ptsB = 0;
    for (const [x, y] of games) { if (x > y) setsA++; else if (y > x) setsB++; ptsA += x; ptsB += y; }
    return { ok: true, games, setsA, setsB, ptsA, ptsB };
  }

  /** Validate a result before it is written. The winner must be in the match. */
  function validateResult(draw, matchId, body) {
    const r = resolveDraw(draw);
    const m = r.byId[String(matchId || '')];
    if (!m) return { ok: false, error: 'Unknown match.', clean: null };
    if (m.bye) return { ok: false, error: 'That match is a bye.', clean: null };
    if (!m.a || !m.b) return { ok: false, error: 'That match is still waiting for an earlier result.', clean: null };
    const winner = clean(obj(body).winner, 40);
    if (winner !== m.a && winner !== m.b) return { ok: false, error: 'Pick which side won.', clean: null };
    const score = clean(obj(body).score, MAX_SCORE);
    return { ok: true, error: '', clean: { winner, score } };
  }

  /** Every later result that a change to `matchId` would invalidate. */
  function downstreamResults(draw, matchId, nextWinner) {
    const before = resolveDraw(draw);
    const d = normalizeDraw(draw);
    d.results[String(matchId)] = { winner: String(nextWinner || ''), score: '', at: 0 };
    const after = resolveDraw(d);
    const lost = [];
    for (const m of before.matches) {
      if (!m.winner || m.bye || m.id === String(matchId)) continue;
      const now = after.byId[m.id];
      if (!now || now.winner !== m.winner) lost.push(m.id);
    }
    return lost;
  }

  // ── standings ────────────────────────────────────────────────────────

  /**
   * Round-robin table. Sorted by matches won, then game difference, then point
   * difference, then head-to-head. Ties that survive all four keep entry order,
   * and `tied` is flagged so an admin knows a coin toss is needed.
   */
  function standings(draw, entrants) {
    const r = resolveDraw(draw);
    const by = {};
    for (const e of arr(entrants)) if (e && e.id) by[e.id] = e;
    const ids = arr(normalizeDraw(draw).slots).filter(Boolean);
    const row = {};
    for (const id of ids) row[id] = { id, label: labelOf(by[id]), played: 0, won: 0, lost: 0, gamesFor: 0, gamesAgainst: 0, ptsFor: 0, ptsAgainst: 0, beat: {} };
    for (const m of r.matches) {
      if (m.id === 'rrfinal' || !m.winner || m.bye) continue;
      const ra = row[m.a], rb = row[m.b];
      if (!ra || !rb) continue;
      ra.played++; rb.played++;
      if (m.winner === m.a) { ra.won++; rb.lost++; ra.beat[m.b] = true; } else { rb.won++; ra.lost++; rb.beat[m.a] = true; }
      const p = parseScore(m.score);
      if (p.ok) {
        ra.gamesFor += p.setsA; ra.gamesAgainst += p.setsB; ra.ptsFor += p.ptsA; ra.ptsAgainst += p.ptsB;
        rb.gamesFor += p.setsB; rb.gamesAgainst += p.setsA; rb.ptsFor += p.ptsB; rb.ptsAgainst += p.ptsA;
      }
    }
    const list = ids.map((id) => row[id]);
    list.sort((a, b) => {
      if (b.won !== a.won) return b.won - a.won;
      const ga = a.gamesFor - a.gamesAgainst, gb = b.gamesFor - b.gamesAgainst;
      if (gb !== ga) return gb - ga;
      const pa = a.ptsFor - a.ptsAgainst, pb = b.ptsFor - b.ptsAgainst;
      if (pb !== pa) return pb - pa;
      if (a.beat[b.id]) return -1;
      if (b.beat[a.id]) return 1;
      return 0;
    });
    return list.map((x, i) => {
      const prev = list[i - 1];
      // Only a tie that has actually been EARNED is worth flagging. Before a
      // ball is hit everyone is level on nothing, and marking a full table
      // "tied" says nothing while looking like a problem.
      const tied = !!prev && prev.played > 0 && x.played > 0
        && prev.won === x.won
        && (prev.gamesFor - prev.gamesAgainst) === (x.gamesFor - x.gamesAgainst)
        && (prev.ptsFor - prev.ptsAgainst) === (x.ptsFor - x.ptsAgainst)
        && !prev.beat[x.id] && !x.beat[prev.id];
      return { pos: i + 1, id: x.id, label: x.label, played: x.played, won: x.won, lost: x.lost, gameDiff: x.gamesFor - x.gamesAgainst, pointDiff: x.ptsFor - x.ptsAgainst, tied };
    });
  }

  /**
   * The round-robin final's two participants: the top two in the table, but only
   * once every group match has been played (otherwise the table is provisional).
   */
  function rrFinalists(draw, entrants) {
    const d = normalizeDraw(draw);
    if (!d.finalAfterRR) return null;
    const r = resolveDraw(d);
    const group = r.matches.filter((m) => m.id !== 'rrfinal');
    if (!group.length || group.some((m) => !m.winner)) return null;
    const t = standings(d, entrants);
    return t.length >= 2 ? { a: t[0].id, b: t[1].id } : null;
  }

  /** Fold the finalists into the skeleton so `rrfinal` resolves like any match. */
  function withRRFinalists(draw, entrants) {
    const d = normalizeDraw(draw);
    const f = rrFinalists(d, entrants);
    if (!f) return d;
    d.matches = d.matches.map((m) => (m.id === 'rrfinal' ? Object.assign({}, m, { aId: f.a, bId: f.b }) : m));
    return d;
  }

  // ── a category's live view ───────────────────────────────────────────

  /**
   * The draw as it should be resolved RIGHT NOW. For a round robin this folds
   * in the two finalists once the group is complete, so `rrfinal` stops being a
   * placeholder and becomes an ordinary match that can be scored.
   */
  function effectiveDraw(cat) {
    const c = normalizeCategory(cat);
    if (!c.draw) return null;
    return c.draw.format === 'roundrobin' ? withRRFinalists(c.draw, c.entrants) : c.draw;
  }

  /**
   * Everything a screen needs for one category: resolved matches carrying real
   * names, the round-robin table when there is one, and who has won. Shared by
   * the admin score sheet and the big-screen bracket so the two can never
   * disagree about what is on court.
   */
  function viewOf(cat) {
    const c = normalizeCategory(cat);
    const d = effectiveDraw(c);
    // Read names off the ORIGINAL entrants, not the normalised copy:
    // normalizeEntrant keeps only the stored shape, which has no `label`, and
    // the public projection is all label and no players.
    const by = {};
    for (const e of arr(obj(cat).entrants)) { const id = clean(obj(e).id, 40); if (id) by[id] = e; }
    for (const e of c.entrants) if (!by[e.id]) by[e.id] = e;
    const lab = (id) => (id ? labelOf(by[id]) : '');
    const club = (id) => (id ? clubOf(by[id]) : '');
    if (!d) {
      return { id: c.id, name: c.name, type: c.type, status: c.status, hasDraw: false, format: effectiveFormat(c),
        matches: [], rounds: [], table: [], champion: null, runnerUp: null, third: null, complete: false };
    }
    const r = resolveDraw(d);
    const matches = r.matches.map((m) => Object.assign({}, m, {
      aLabel: lab(m.a) || (m.bye ? '' : 'TBC'),
      bLabel: lab(m.b) || (m.bye ? 'Bye' : 'TBC'),
      aClub: club(m.a), bClub: club(m.b),
      winnerLabel: lab(m.winner),
    }));
    const rounds = [];
    for (const m of matches) {
      let g = rounds.find((x) => x.round === m.round && x.label === m.label);
      if (!g) { g = { round: m.round, label: m.label, matches: [] }; rounds.push(g); }
      g.matches.push(m);
    }
    return {
      id: c.id, name: c.name, type: c.type, status: c.status, hasDraw: true,
      format: r.format, size: r.size, matches, rounds,
      table: r.format === 'roundrobin' ? standings(d, arr(obj(cat).entrants).length ? arr(obj(cat).entrants) : c.entrants) : [],
      champion: r.champion, championLabel: lab(r.champion),
      runnerUp: r.runnerUp, runnerUpLabel: lab(r.runnerUp),
      third: r.third, thirdLabel: lab(r.third),
      complete: r.complete,
      onCourt: matches.filter((m) => m.state === 'ready' && m.court),
      upNext: matches.filter((m) => m.state === 'ready' && !m.court),
    };
  }

  // ── public projection ────────────────────────────────────────────────

  /**
   * The ONLY shape the unauthenticated GET may serve. Drops every phone number,
   * every IC (blob and last four), every pending or withdrawn entrant, the
   * payment flags and the category codes. What is left is what a bracket on a
   * screen in a hall needs: labels, seeds, clubs, matches and scores.
   */
  function publicKnockout(ko) {
    const k = normalize(ko);
    if (!k.event.published) return { event: { name: '', date: '', venue: '', regOpen: false, published: false }, categories: [] };
    return {
      event: k.event,
      categories: k.categories.map((c) => ({
        id: c.id, name: c.name, type: c.type, status: c.status, fee: c.fee,
        format: effectiveFormat(c),
        entries: confirmedOf(c).length,
        spacesLeft: spacesLeft(c),
        // `hasCode` lets the public page show "enter your code" without listing codes.
        hasCode: !!c.code,
        entrants: confirmedOf(c).map((e) => ({ id: e.id, label: entrantLabel(e), club: entrantClub(e), seed: e.seed })),
        draw: c.draw ? publicDraw(c.draw) : null,
      })),
    };
  }

  /**
   * The crumb the LOCKED screen may show: enough for "TZH Open, 8 Nov — enter
   * your code", and nothing else. No entrants, no brackets, no codes. The
   * locked screen is served to anyone at all, so this stays deliberately thin.
   */
  function teaser(ko) {
    const k = normalize(ko);
    if (!k.event.published) return null;
    const open = k.categories.filter((c) => c.status === 'open' && c.code).length;
    return { name: k.event.name, date: k.event.date, venue: k.event.venue, regOpen: !!k.event.regOpen && open > 0, categories: open };
  }

  /**
   * The shape the 2-second ADMIN poll carries. Same as the stored blob minus the
   * encrypted IC blobs, which are bulky and have no business riding a poll —
   * the admin tab fetches them (masked) through knockoutGetAdmin, and the full
   * number only ever arrives through an audited reveal.
   */
  function pollKnockout(ko) {
    const k = normalize(ko);
    for (const c of k.categories) {
      for (const e of c.entrants) e.players = e.players.map((p) => ({ name: p.name, phone: p.phone, club: p.club, icLast4: p.icLast4, hasIC: !!p.icEnc }));
    }
    return k;
  }

  function publicDraw(draw) {
    const d = normalizeDraw(draw);
    return { format: d.format, size: d.size, slots: d.slots, matches: d.matches, results: d.results, thirdPlace: d.thirdPlace, finalAfterRR: d.finalAfterRR, generatedAt: d.generatedAt };
  }

  /** Admin list projection: masked IC only. The full number needs a reveal action. */
  function adminEntrant(e) {
    const n = normalizeEntrant(e);
    return {
      id: n.id, at: n.at, status: n.status, paid: n.paid, paidAt: n.paidAt, seed: n.seed, note: n.note,
      label: entrantLabel(n), club: entrantClub(n),
      players: n.players.map((p) => ({ name: p.name, phone: p.phone, club: p.club, ic: maskIC(p.icLast4), hasIC: !!p.icEnc })),
    };
  }

  // ── counts for the admin nav badge ───────────────────────────────────

  /** Entries waiting for the admin to confirm or mark paid — the blue pill. */
  function todoCount(ko) {
    const k = normalize(ko);
    let n = 0;
    for (const c of k.categories) {
      n += pendingOf(c).length;
      n += confirmedOf(c).filter((e) => !e.paid).length;
    }
    return n;
  }

  function summary(cat) {
    const c = normalizeCategory(cat);
    const conf = confirmedOf(c).length;
    const fmt = effectiveFormat(c, conf);
    return {
      id: c.id, name: c.name, type: c.type, status: c.status, code: c.code,
      confirmed: conf, pending: pendingOf(c).length, unpaid: confirmedOf(c).filter((e) => !e.paid).length,
      format: fmt, formatLabel: formatLabel(fmt),
      size: fmt === 'knockout' ? bracketSize(conf) : conf,
      byes: fmt === 'knockout' ? byeCount(conf) : 0,
      hasDraw: !!c.draw,
    };
  }

  return {
    // limits
    MAX_CATEGORIES, MAX_ENTRANTS, MAX_PER_SUBMIT, AUTO_RR_MAX, MIN_DRAW,
    MIN_NAME, MAX_NAME, MIN_PHONE_DIGITS, MAX_PHONE_DIGITS, MIN_IC, MAX_IC,
    MAX_CLUB, MAX_CAT_NAME, MAX_EVENT_NAME, MAX_VENUE, MAX_SCORE, MAX_FEE, MAX_CAP,
    CODE_ALPHABET, CODE_LEN, FREE_AGENT, TYPES, FORMATS, CAT_STATUS, ENT_STATUS,
    // helpers
    normIC, icLast4, maskIC, newId, genCode, normCode, isValidCode, digits,
    // state
    emptyKnockout, normalize, normalizeEvent, normalizeCategory, normalizeEntrant, normalizeDraw,
    categoriesOf, findCategory, findByCode, codeTaken, freshCode,
    // entrants
    playersNeeded, entrantLabel, entrantClub, labelOf, clubOf, confirmedOf, pendingOf, activeOf, isFull, spacesLeft,
    validateEntry, validateSubmission, isDuplicateEntry,
    // format + seeding
    effectiveFormat, formatLabel, bracketSize, seedOrder, seedSlots, byeCount, roundName, roundCount,
    // draws
    buildKnockoutDraw, buildRoundRobinDraw, buildDraw, resolveDraw, readyMatches, upcomingMatches,
    parseScore, validateResult, downstreamResults, standings, rrFinalists, withRRFinalists,
    // views + projections
    effectiveDraw, viewOf,
    publicKnockout, publicDraw, teaser, pollKnockout, adminEntrant, todoCount, summary,
  };
});
