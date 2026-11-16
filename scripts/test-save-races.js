#!/usr/bin/env node
/*
 * test-save-races.js — the admin's saves and the 2s poll must not undo each other.
 *
 * Reported 2026-11-10 with a screenshot of a free court card: "when I put a name
 * here, it sometimes would not leave it there". Two defects, both reproduced in a
 * browser with ~700ms of network latency before the fix:
 *
 *   1. A poll GET that overlapped a save could be answered before the save
 *      landed, and poll() applied it — the name vanished for one tick. A second
 *      pick inside that window was built on the wiped board and saved it, so the
 *      first name was lost for good (4 out of 4 runs). Fix: apiPost bumps
 *      __writeSeq at start and end; poll()/refreshState() drop an answer whose
 *      window overlapped a save (pollIsStale). Saves are also sent one at a time,
 *      in order (__postChain), because most carry a whole list.
 *
 *   2. Ticking people in at the door: each tap ran its own refresh + save of the
 *      whole players list, so overlapping taps each saved a list missing the
 *      others — 8 quick ticks kept 4. Fix: taps are intents (tickIntents) that one
 *      worker (flushTickIntents) saves in batches.
 *
 * Pure helpers are unit-tested; the tick worker and apiPost run for real against
 * a fake server with random latency on every request. Exit 0 = green.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFn(name, src) {
  const sigs = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const sig of sigs) { start = src.indexOf(sig); if (start !== -1) break; }
  if (start === -1) throw new Error('missing function ' + name);
  const braceOpen = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name); } };

// ── pure: pollIsStale ─────────────────────────────────────────────
const pollIsStale = new Function(extractFn('pollIsStale', html) + '; return pollIsStale;')();
check('no save during the GET → apply it', pollIsStale(4, 4, 0) === false);
check('a save still in flight → drop it', pollIsStale(4, 4, 1) === true);
check('a save started and finished during the GET → drop it', pollIsStale(4, 6, 0) === true);

// ── pure: applyTickIntent ─────────────────────────────────────────
const applyTickIntent = new Function(
  extractFn('stripPlayerFromRounds', html) + ';' + extractFn('applyTickIntent', html) + '; return applyTickIntent;')();
const roster = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }];
const rounds = [{ courts: [{ team1: ['a', 'x'], team2: ['', ''] }] }];
let r = applyTickIntent([], rounds, roster, 'a', true);
check('tick in adds the roster player', r.players.length === 1 && r.players[0].name === 'Ann' && !r.roundsChanged);
r = applyTickIntent([{ id: 'a', name: 'Ann' }], rounds, roster, 'a', false);
check('tick out removes them and clears their court seat', r.players.length === 0 && r.roundsChanged && r.rounds[0].courts[0].team1[0] === '');
check('tick out never mutates the input rounds', rounds[0].courts[0].team1[0] === 'a');
r = applyTickIntent([{ id: 'a', name: 'Ann' }], rounds, roster, 'a', true);
check('tick in for someone already in is a no-op', r.players.length === 1);
r = applyTickIntent([], rounds, roster, 'zz', true);
check('unknown id is a no-op', r.players.length === 0);

// ── behaviour: the real apiPost / refreshState / tick worker ───────
// A fake server: every request waits a random 20–200ms before it "arrives", so
// two in flight can land in either order — exactly the Vercel situation.
function makeWorld() {
  const server = {
    roster: Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, photo: null })),
    players: [], rounds: [{ courts: [{ team1: ['', ''], team2: ['', ''] }, { team1: ['', ''], team2: ['', ''] }] }],
    courtRounds: [0, 0], numCourts: 2,
  };
  const log = [];
  const jitter = () => new Promise(res => setTimeout(res, 20 + Math.random() * 180));
  const fetch = async (url, opts) => {
    await jitter();
    if (opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      delete body.password;
      Object.assign(server, JSON.parse(JSON.stringify(body)));
      log.push(Object.keys(body).join(','));
      await jitter();
      return { status: 200, json: async () => ({ ok: true }) };
    }
    const snap = JSON.parse(JSON.stringify(server));
    await jitter();
    return { status: 200, json: async () => snap };
  };
  const ctx = {
    fetch, console, setTimeout, Promise, JSON, Map, Set, Date, Number, Math, Array, Object, String, Error,
    sessionStorage: { getItem: () => 'pw', removeItem() {} },
    localStorage: { getItem: () => '' },
    encodeURIComponent,
    notify: (m) => { ctx.__notes.push(m); }, __notes: [],
    renderPlayersSection() {}, renderCourtControls() {}, renderPlayed() {}, renderViewer() {},
    showViewer() {}, requestAdmin() {},
    clockOffset: 0,
  };
  vm.createContext(ctx);
  const code = [
    'var state = null; var clockOffset = 0;',
    'let __writeSeq = 0; let __writesInFlight = 0; let __postChain = Promise.resolve();',
    'const pendingTicks = new Set(); const tickIntents = new Map(); let tickWorker = null;',
    extractFn('getAdminPwd', html), extractFn('fetchWithTimeout', html), extractFn('apiFetch', html), extractFn('pollIsStale', html),
    extractFn('apiPost', html), extractFn('refreshState', html),
    extractFn('stripPlayerFromRounds', html), extractFn('applyTickIntent', html),
    extractFn('overlayTickIntents', html), extractFn('toggleRosterPlayer', html), extractFn('flushTickIntents', html),
    extractFn('applyCourtPlacement', html),
    'this.api = { apiPost, refreshState, toggleRosterPlayer, applyCourtPlacement, get state() { return state; }, set state(v) { state = v; }, get worker() { return tickWorker; }, pendingTicks };',
  ].join('\n');
  vm.runInContext(code, ctx);
  return { server, api: ctx.api, ctx, log };
}

(async () => {
  // 1) Eight quick ticks at the door, then all eight out again.
  for (let run = 0; run < 5; run++) {
    const { server, api } = makeWorld();
    await api.refreshState();
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    for (const id of ids) { api.toggleRosterPlayer(id); await new Promise(res => setTimeout(res, Math.random() * 60)); }
    while (api.worker) await api.worker;
    check(`run ${run}: all 8 ticks reach the server`, ids.every(id => server.players.some(p => p.id === id)));
    check(`run ${run}: the screen agrees`, ids.every(id => api.state.players.some(p => p.id === id)));
    check(`run ${run}: nothing left pending`, api.pendingTicks.size === 0);
    for (const id of ids) { api.toggleRosterPlayer(id); await new Promise(res => setTimeout(res, Math.random() * 60)); }
    while (api.worker) await api.worker;
    check(`run ${run}: all 8 untick`, server.players.length === 0 && api.state.players.length === 0);
  }

  // 2) A double tap on the same card nets out to nothing.
  {
    const { server, api } = makeWorld();
    await api.refreshState();
    api.toggleRosterPlayer('p3');
    api.toggleRosterPlayer('p3');
    while (api.worker) await api.worker;
    check('tap-tap on one card leaves them out', !server.players.some(p => p.id === 'p3'));
  }

  // 3) Court picks in a row: each save carries the whole board, so they must
  //    land in the order they were made or an older board wins.
  for (let run = 0; run < 5; run++) {
    const { server, api } = makeWorld();
    await api.refreshState();
    const seats = [['team1', 0, 'p0'], ['team1', 1, 'p1'], ['team2', 0, 'p2'], ['team2', 1, 'p3']];
    const saves = [];
    for (const [team, k, id] of seats) {
      const rounds = api.applyCourtPlacement(api.state.rounds, [0, 0], 2, 0, team, k, id);
      api.state.rounds = rounds;
      saves.push(api.apiPost({ rounds }));
    }
    await Promise.all(saves);
    const c = server.rounds[0].courts[0];
    check(`run ${run}: four quick court picks all stick`, [...c.team1, ...c.team2].join() === 'p0,p1,p2,p3');
  }

  // 4) refreshState during a save keeps the local copy (the save is not on the
  //    server yet, so the fetched copy would be older than the screen).
  {
    const { api } = makeWorld();
    await api.refreshState();
    api.state.numCourts = 3;
    const save = api.apiPost({ numCourts: 3 });
    await api.refreshState();
    check('a refresh waits for the queued save, so it sees it', api.state.numCourts === 3);
    await save;
  }

  // 5) A refused save says so by itself — callers used to show "Saved" anyway.
  {
    const { api, ctx } = makeWorld();
    ctx.fetch = async () => ({ status: 400, json: async () => ({ error: 'Invalid fee tier.' }) });
    const res = await api.apiPost({ feeTier: 'x' });
    check('apiPost hands back the error', res && res.error === 'Invalid fee tier.');
    check('apiPost tells the organiser itself', ctx.__notes.includes('Invalid fee tier.'));
    ctx.__notes.length = 0;
    ctx.fetch = async () => ({ status: 504, json: async () => { throw new Error('not json'); } });
    const res2 = await api.apiPost({ numCourts: 2 });
    check('an HTML error page becomes a readable error, not a crash', res2 && /504/.test(res2.error) && ctx.__notes.length === 1);
    const quiet = await api.apiPost({ numCourts: 2 }, { quiet: true });
    check('quiet callers handle the message themselves', quiet.error && ctx.__notes.length === 1);
  }

  // 6) A warning is not covered by the "Saved" toast that follows it.
  {
    const el = { textContent: '', classList: { toggle() {}, add() {}, remove() {} } };
    const notify = new Function('document', 'setTimeout', 'clearTimeout',
      'let __notifTimer = null; let __notifWarnUntil = 0;\n' + extractFn('notify', html) + '; return notify;')(
      { getElementById: () => el }, () => 0, () => {});
    notify('Not saved.', 'error');
    notify('Saved!');
    check('a success toast right after a failed save does not replace it', el.textContent === 'Not saved.');
    notify('Another problem', 'warn');
    check('a newer warning still shows', el.textContent === 'Another problem');
    notify('Not saved.', 'error');
    notify('Temporary password: abc123', 'ok');
    check('an ok message (a temp password) always shows', el.textContent === 'Temporary password: abc123');
    notify('Tap again to move', 'warn');
    notify('Date set.');
    check('a plain warning (a prompt) does not hold back the next message', el.textContent === 'Date set.');
  }

  console.log(`save races: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
