#!/usr/bin/env node
/* test-roster-add — "Add Multiple to Roster" (2026-09-12).
 *
 * Reported as "I cannot add multiple people to the roster". The bulk add used to
 * POST the ENTIRE roster back (every base64 photo included) just to append a few
 * names, and confirmBulkImport never read the response — so ANY server refusal
 * (storage error, auth, size) still closed the modal and showed a green
 * "Added N players to roster!" toast while nothing was saved and the typing was
 * lost. The client now sends only the names via the addRosterPlayers action.
 *
 * Covers the pure builder, the HTTP branch, and the client wiring. */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const S = require('../api/state.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + name); } };

function extractFn(name, src) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const fn = (name) => extractFn(name, html) || '';
const B = S.buildRosterAdditions;

// ── the pure builder ──
const AZ = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const r26 = B([], AZ, 1000);
check('26 pasted names produce 26 players (the reported case)', r26.ok && r26.players.length === 26);
check('names are kept in the pasted order', r26.ok && r26.players.map(p => p.name).join('') === AZ.join(''));
check('every id in one paste is unique', new Set(r26.players.map(p => p.id)).size === 26);
check('ids do not collide across two pastes in the same millisecond', (() => {
  const a = B([], AZ, 1000).players.map(p => p.id);
  const b = B([], AZ, 1000).players.map(p => p.id);
  return new Set([...a, ...b]).size === 52;
})());
check('new players start with no photo and zero points', r26.players.every(p => p.photo === null && p.points === 0));

check('blank lines and stray whitespace are dropped', (() => {
  const r = B([], ['  Alex  ', '', '   ', '\tBea\n'], 1);
  return r.ok && r.players.length === 2 && r.players[0].name === 'Alex' && r.players[1].name === 'Bea';
})());
check('runs of inner whitespace collapse to one space', B([], ['Jun    Xian'], 1).players[0].name === 'Jun Xian');
check('names are capped at MAX_ROSTER_NAME characters', B([], ['x'.repeat(200)], 1).players[0].name.length === S.MAX_ROSTER_NAME);
check('non-string entries are coerced, not crashed on', (() => {
  const r = B([], [42, null, undefined, 'Cy'], 1);
  return r.ok && r.players.map(p => p.name).join(',') === '42,Cy';
})());

check('an empty paste is refused with a message', (() => { const r = B([], ['', '  '], 1); return !r.ok && /No names entered/.test(r.error); })());
check('a non-array names field is refused', !B([], 'Alex', 1).ok && !B([], null, 1).ok && !B([], undefined, 1).ok);
check('more than MAX_BULK_ADD names at once is refused', (() => {
  const many = Array.from({ length: S.MAX_BULK_ADD + 1 }, (_, i) => 'P' + i);
  const r = B([], many, 1);
  return !r.ok && r.error.includes(String(S.MAX_BULK_ADD));
})());
check('exactly MAX_BULK_ADD names is allowed', B([], Array.from({ length: S.MAX_BULK_ADD }, (_, i) => 'P' + i), 1).ok);
check('overflowing MAX_ROSTER is refused and says the resulting size', (() => {
  const existing = Array.from({ length: S.MAX_ROSTER - 1 }, (_, i) => ({ id: 'r' + i, name: 'P' + i }));
  const r = B(existing, ['a', 'b', 'c'], 1);
  return !r.ok && r.error.includes(String(S.MAX_ROSTER)) && r.error.includes(String(S.MAX_ROSTER + 2));
})());
check('a missing/!array roster is treated as empty, not a crash', B(null, ['Alex'], 1).ok && B(undefined, ['Alex'], 1).ok);
check('the builder never mutates the roster it is given', (() => {
  const existing = [{ id: 'r1', name: 'Alex' }];
  B(existing, ['Bea'], 1);
  return existing.length === 1;
})());
check('the builder only returns the NEW players, not the merged list', B([{ id: 'r1', name: 'Alex' }], ['Bea'], 1).players.length === 1);

// ── HTTP branch ──
const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'state.js'), 'utf8');
check('addRosterPlayers is dispatched before the unknown-action 400', src.indexOf("updates.action === 'addRosterPlayers'") < src.indexOf("return res.status(400).json({ error: 'Unknown action.' });"));
check('a refused build answers 400 with the reason', src.includes('if (!built.ok) return res.status(400).json({ error: built.error });'));
check('the branch appends to the freshly-read server roster', src.includes('state.roster = [...(Array.isArray(state.roster) ? state.roster : []), ...built.players];'));
check('a failed KV write answers 500 instead of pretending to succeed', /KV write error \(addRosterPlayers\)[\s\S]{0,140}res\.status\(500\)/.test(src));
check('the branch returns the count and the new roster', src.includes("return res.json({ ok: true, added: built.players.length, roster: state.roster });"));
check('server.js mirrors the branch for local dev', (() => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  return srv.includes("updates.action === 'addRosterPlayers'") && srv.includes('buildRosterAdditions');
})());

// ── client wiring ──
const c = fn('confirmBulkImport');
check('the client posts only the names, never the whole roster', c.includes("apiPost({ action: 'addRosterPlayers', names })") && !c.includes('apiPost({ roster })'));
check('the client no longer builds player ids itself', !c.includes("'r' + Date.now()"));
check('a server error is shown and the modal stays open with the typing intact', c.includes("if (!r.ok || r.error) return notify(r.error || 'Could not add those players.', 'warn');") && c.indexOf('return notify(r.error') < c.indexOf('closeBulkModal()'));
check('a network error is reported instead of a success toast', c.includes("notify('Network error. Nobody was added. Your names are still here.', 'warn')"));
check('a 401 (apiPost returned null) exits quietly — the password prompt is already up', c.includes('if (!r) return;'));
check('the success toast uses the count the SERVER confirmed', c.includes('notify(`Added ${r.added} player${r.added === 1 ? \'\' : \'s\'} to roster!`)'));
check('the roster comes back from the server, not from a local guess', c.includes('state.roster = r.roster;'));
check('the submit button shows progress and is re-enabled on every path', c.includes("btn.disabled = true; btn.textContent = 'Adding…'") && c.includes("const restore = () =>") && (c.match(/restore\(\);/g) || []).length >= 2);
check('the submit button has the id the handler looks up', html.includes('<button class="btn btn-primary" id="bulkSubmitBtn" onclick="confirmBulkImport()">Add Players</button>'));

// the same silent-success bug lived in the single-player and guest paths
check('single add now reports a refused write', fn('confirmAddRoster').includes("if (r.error) return notify(r.error, 'warn');") && fn('confirmAddRoster').indexOf('if (r.error)') < fn('confirmAddRoster').indexOf('closeAddRosterModal()'));
check('guest add now reports a refused write', fn('confirmAddGuest').includes("if (r.error) return notify(r.error, 'warn');") && fn('confirmAddGuest').indexOf('if (r.error)') < fn('confirmAddGuest').indexOf('closeGuestModal()'));

console.log(`\ntest-roster-add: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
