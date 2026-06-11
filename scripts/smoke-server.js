#!/usr/bin/env node
/*
 * smoke-server.js — proves the running local app round-trips (Phase 5).
 *
 * Spawns `node server.js` on an ephemeral port and asserts:
 *   1. GET /                       → 200 and body contains id="viewer"
 *   2. POST /api/state (good pwd)  → {ok:true} and a follow-up GET reflects it
 *   3. POST /api/state (bad pwd)   → 401
 *
 * Exit 0 = all pass; exit 1 = any failure. Always kills the spawned server.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '3517';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.ADMIN_PASSWORD || 'TZH123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForUp(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); else console.log(`  PASS  ${msg}`); };

  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let exitCode = 1;
  try {
    const up = await waitForUp();
    if (!up) { console.log('  FAIL  server did not start within timeout'); throw new Error('no-start'); }

    // 1. GET /
    const home = await fetch(`${BASE}/`);
    const homeBody = await home.text();
    check(home.status === 200, `GET / → 200 (got ${home.status})`);
    check(homeBody.includes('id="viewer"'), 'GET / body contains id="viewer"');

    // 2. POST with valid password persists
    const post = await fetch(`${BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, numCourts: 3 }),
    });
    const postJson = await post.json().catch(() => ({}));
    check(post.status === 200 && postJson.ok === true, `POST /api/state (good pwd) → {ok:true} (got ${post.status} ${JSON.stringify(postJson)})`);

    const after = await fetch(`${BASE}/api/state`);
    const afterJson = await after.json();
    check(afterJson.numCourts === 3, `GET /api/state reflects persisted numCourts===3 (got ${afterJson.numCourts})`);

    // 3. POST with wrong password rejected
    const bad = await fetch(`${BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-pw', numCourts: 9 }),
    });
    check(bad.status === 401, `POST /api/state (bad pwd) → 401 (got ${bad.status})`);

    exitCode = failures.length ? 1 : 0;
  } catch (e) {
    if (e.message !== 'no-start') console.log(`  ERROR ${e.message}`);
  } finally {
    server.kill('SIGTERM');
    await sleep(100);
    if (!server.killed) server.kill('SIGKILL');
  }

  console.log('');
  if (failures.length) {
    failures.forEach((f) => console.log(`  FAIL  ${f}`));
    console.log(`\nsmoke-server: FAIL — ${failures.length} issue(s).`);
  } else {
    console.log('smoke-server: PASS — app serves and round-trips.');
  }
  process.exit(exitCode);
})();
