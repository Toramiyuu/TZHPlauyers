#!/usr/bin/env node
/*
 * migrate-nights.js — one-time cleanup of the phantom off-day payment records.
 *
 *   node scripts/migrate-nights.js                  # DRY RUN: print the plan, write nothing
 *   node scripts/migrate-nights.js --apply          # back up, then write
 *   node scripts/migrate-nights.js --file dump.json # plan against a local state dump
 *
 * The old 00:00 rollover cut a Friday night in half, so anything logged after
 * midnight (End of the day, payment ticks) landed on a Saturday record. This
 * folds each of those back into the night that owned it. See lib/night-migrate.js
 * for the rules and public/night.js for the boundary that stops it recurring.
 *
 * --apply ALWAYS writes a timestamped backup of the untouched state next to the
 * repo first, and refuses to run if that backup cannot be written.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { planNightMerge, applyNightMerge } = require(path.join(ROOT, 'lib', 'night-migrate.js'));
const Payments = require(path.join(ROOT, 'public', 'payments.js'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const fileIdx = argv.indexOf('--file');
const FILE = fileIdx !== -1 ? argv[fileIdx + 1] : null;
const STATE_KEY = 'court-state';

function redisClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = require(path.join(ROOT, 'node_modules', '@upstash', 'redis'));
  return new Redis({ url, token });
}

function money(n) { return Payments.fmtRM(n); }

function report(state, plan) {
  const att = state.attendance || {};
  console.log('\n=== NIGHT MERGE PLAN ' + (APPLY ? '(APPLYING)' : '(DRY RUN — nothing will be written)') + ' ===\n');

  if (!plan.merges.length) {
    console.log('  No phantom off-day records found. Nothing to merge.');
  }
  let totalMoved = 0, totalAdopted = 0, totalMoney = 0;
  for (const m of plan.merges) {
    const day = att[m.from] || {};
    const recs = Object.values(day.entries || {}).filter((e) => e && e.payment);
    const owed = recs.filter((e) => !e.paid).reduce((a, e) => a + (e.payment.fee || 0), 0);
    const took = recs.filter((e) => e.paid).reduce((a, e) => a + (e.payment.fee || 0), 0);
    totalMoney += took;
    console.log('  ' + m.from + '  →  ' + m.to + (m.targetExists ? '' : '   (the night has NO record yet — the whole day moves)'));
    console.log('     ' + recs.length + ' payment record(s) · ' + money(took) + ' collected · ' + money(owed) + ' outstanding');
    for (const e of m.entries) {
      const mark = e.action === 'move' ? '+' : e.action === 'adopt-paid' ? '$' : '·';
      console.log('       ' + mark + ' ' + e.name.padEnd(18) + e.action.padEnd(12) + e.reason);
    }
    totalMoved += m.moved; totalAdopted += m.adopted;
    console.log('');
  }

  if (plan.sessionDate) {
    console.log('  LIVE  session date ' + plan.sessionDate.from + ' → ' + plan.sessionDate.to
      + '   (it was parked on an off day by the old midnight cron)');
  }
  for (const d of plan.drops) console.log('  DROP  session snapshot ' + d.date + ' — ' + d.reason);
  for (const w of plan.warnings) console.log('  WARN  ' + w);

  console.log('\n  ── summary ──');
  console.log('  ghost dates      : ' + plan.strayDates.length + (plan.strayDates.length ? '  (' + plan.strayDates.join(', ') + ')' : ''));
  console.log('  records moved    : ' + totalMoved);
  console.log('  payments adopted : ' + totalAdopted + '   (paid after midnight, credited back to the right night)');
  console.log('  snapshots dropped: ' + plan.drops.length);
  console.log('  money re-homed   : ' + money(totalMoney));
  console.log('\n  Past draw results are NOT recalculated — announced winners stand.\n');
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
      console.error('Run `vercel env pull .env.local` and re-run with:');
      console.error('  set -a && . .env.local && set +a && node scripts/migrate-nights.js');
      console.error('…or plan against a dump with --file <state.json>.');
      process.exit(2);
    }
    state = await client.get(STATE_KEY);
    if (!state) { console.error('No state found at key "' + STATE_KEY + '".'); process.exit(2); }
    console.log('Loaded live state from Redis (' + STATE_KEY + ').');
  }

  const plan = planNightMerge(state);
  report(state, plan);

  if (!APPLY) {
    console.log('Dry run complete. Re-run with --apply to write (a backup is taken first).');
    return;
  }
  if (!plan.merges.length && !plan.drops.length && !plan.sessionDate) {
    console.log('Nothing to apply.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(ROOT, 'state-backup-' + stamp + '.json');
  fs.writeFileSync(backup, JSON.stringify(state, null, 2));
  console.log('Backup written: ' + backup);

  const summary = applyNightMerge(state, plan);
  if (FILE) {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    console.log('Wrote merged state back to ' + FILE);
  } else {
    await client.set(STATE_KEY, state);
    console.log('Wrote merged state to Redis.');
  }
  console.log('Applied: ' + JSON.stringify(summary, null, 2));

  const after = planNightMerge(state);
  console.log(after.merges.length ? 'WARNING: plan is not empty after applying.' : 'Verified: no ghost dates remain.');
})().catch((e) => { console.error('migrate-nights failed:', e && e.message); process.exit(1); });
