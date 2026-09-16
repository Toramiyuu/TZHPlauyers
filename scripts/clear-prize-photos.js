#!/usr/bin/env node
/*
 * clear-prize-photos.js — drop the uploaded photo from matching prizes.
 *
 *   node scripts/clear-prize-photos.js                    # DRY RUN, matches /grip/i
 *   node scripts/clear-prize-photos.js --apply
 *   node scripts/clear-prize-photos.js --match "grip|tube"
 *   node scripts/clear-prize-photos.js --all              # every prize, any name
 *   node scripts/clear-prize-photos.js --file dump.json
 *
 * Prize photos are base64 data URLs held on the LIVE settings only:
 * state.drawSettings.prizes[] (Session draw) and state.monthlyLucky.prizes[]
 * (Monthly draw). Permanent draw records never carry them, because
 * SessionDraw.litePrizes() nulls the photo before a result is written, so
 * clearing one here cannot rewrite draw history. The prize keeps its name,
 * quantity, place and description; only the picture goes.
 *
 * --apply always writes a timestamped backup of the untouched state first.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const arg = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const FILE = arg('--file');
const MATCH = ALL ? null : new RegExp(arg('--match') || 'grip', 'i');
const STATE_KEY = 'court-state';

function redisClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = require(path.join(ROOT, 'node_modules', '@upstash', 'redis'));
  return new Redis({ url, token });
}

const BUCKETS = [
  { label: 'Session draw', get: (s) => s.drawSettings && s.drawSettings.prizes },
  { label: 'Monthly draw', get: (s) => s.monthlyLucky && s.monthlyLucky.prizes },
];

function kb(str) { return Math.round((String(str || '').length * 3 / 4) / 1024); }

/** Pure: what would change. Returns [{bucket, index, name, sizeKb}]. */
function plan(state) {
  const hits = [];
  for (const b of BUCKETS) {
    const list = b.get(state || {});
    if (!Array.isArray(list)) continue;
    list.forEach((p, i) => {
      if (!p || !p.photo) return;
      if (MATCH && !MATCH.test(String(p.name || ''))) return;
      hits.push({ bucket: b.label, index: i, name: p.name || '(unnamed)', sizeKb: kb(p.photo) });
    });
  }
  return hits;
}

function apply(state, hits) {
  const byBucket = new Map(BUCKETS.map((b) => [b.label, b]));
  for (const h of hits) {
    const list = byBucket.get(h.bucket).get(state);
    if (list && list[h.index]) list[h.index].photo = null;
  }
}

(async function main() {
  let state, client = null;
  if (FILE) {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    console.log('Loaded state from ' + FILE);
  } else {
    client = redisClient();
    if (!client) {
      console.error('No Redis credentials in the environment.');
      console.error('Run `vercel env pull .env.local`, then:');
      console.error('  set -a && . .env.local && set +a && node scripts/clear-prize-photos.js');
      process.exit(2);
    }
    state = await client.get(STATE_KEY);
    if (!state) { console.error('No state at key "' + STATE_KEY + '".'); process.exit(2); }
    console.log('Loaded live state from Redis.');
  }

  console.log('\nMatching: ' + (MATCH ? MATCH : 'EVERY prize with a photo'));
  console.log('=== PRIZE PHOTOS ' + (APPLY ? '(APPLYING)' : '(DRY RUN, nothing written)') + ' ===\n');

  // Show the whole prize list for context, so a wrong match is obvious.
  for (const b of BUCKETS) {
    const list = b.get(state) || [];
    console.log('  ' + b.label + ': ' + (list.length ? '' : '(no prizes)'));
    list.forEach((p, i) => {
      const hit = p && p.photo && (!MATCH || MATCH.test(String(p.name || '')));
      console.log('     ' + (hit ? '>' : ' ') + ' [' + i + '] ' + String(p && p.name || '(unnamed)').padEnd(28)
        + (p && p.photo ? 'photo ' + kb(p.photo) + 'KB' + (hit ? '  <-- will be cleared' : '') : 'no photo'));
    });
    console.log('');
  }

  const hits = plan(state);
  console.log('  ' + hits.length + ' photo(s) to clear' + (hits.length ? ', freeing ~' + hits.reduce((a, h) => a + h.sizeKb, 0) + 'KB' : '') + '.');
  console.log('  Prize names, quantities and descriptions are untouched. Draw history is unaffected.\n');

  if (!APPLY) { console.log('Dry run. Re-run with --apply to write (a backup is taken first).'); return; }
  if (!hits.length) { console.log('Nothing to apply.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(ROOT, 'state-backup-' + stamp + '.json');
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log('Backup written: ' + backup);

  apply(state, hits);
  if (FILE) { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); console.log('Wrote ' + FILE); }
  else { await client.set(STATE_KEY, state); console.log('Wrote merged state to Redis.'); }
  console.log(plan(state).length ? 'WARNING: matches remain after applying.' : 'Verified: no matching photos remain.');
})().catch((e) => { console.error('clear-prize-photos failed:', e && e.message); process.exit(1); });
