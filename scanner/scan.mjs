// Local-only scanner. Requires an authenticated `gh` CLI. Not deployed.
// Usage: node scanner/scan.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, sortRecords, VERDICTS } from '../lib/verdict.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data', 'claimable.json');
const CAP = 150;
const SEARCH_SLEEP_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `gh api` with an argument array (no shell). Returns parsed JSON or throws. */
function gh(args) {
  const res = spawnSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh api failed (${res.status}): ${(res.stderr || '').trim().slice(0, 200)}`);
  return JSON.parse(res.stdout);
}

const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const base = `is:issue is:open created:>=${since}`;
const QUERIES = [
  `${base} label:bounty`,
  `${base} label:"💎 Bounty"`,
  `${base} "/bounty" in:comments`,
  `${base} label:"$50","$100","$150","$200","$500"`,
  `${base} "Price:" "USD" in:body label:"Priority: 2 (Medium)"`,
];

async function search() {
  const byUrl = new Map();
  for (let i = 0; i < QUERIES.length; i++) {
    if (i > 0) await sleep(SEARCH_SLEEP_MS);
    try {
      const data = gh(['-X', 'GET', 'search/issues', '-f', `q=${QUERIES[i]}`, '-f', 'per_page=100', '-f', 'sort=created', '-f', 'order=desc']);
      const items = data.items || [];
      for (const it of items) if (!it.pull_request) byUrl.set(it.html_url, it);
      console.error(`query ${i + 1}/${QUERIES.length}: ${items.length} results`);
    } catch (e) {
      console.error(`query ${i + 1} failed: ${e.message}`);
    }
  }
  return [...byUrl.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, CAP);
}

const repoCache = new Map();
function getRepo(fullName) {
  if (!repoCache.has(fullName)) repoCache.set(fullName, gh([`repos/${fullName}`]));
  return repoCache.get(fullName);
}

function countCrossRefPrs(timeline) {
  const prs = new Set();
  for (const ev of timeline) {
    if (ev.event === 'cross-referenced' && ev.source?.issue?.pull_request) prs.add(ev.source.issue.id ?? ev.source.issue.html_url);
  }
  return prs.size;
}

async function main() {
  const issues = await search();
  console.error(`candidates after dedupe/cap: ${issues.length}`);
  const records = [];
  let skipped = 0;
  for (const issue of issues) {
    const fullName = (issue.repository_url || '').replace(/^.*\/repos\//, '');
    try {
      const repo = getRepo(fullName);
      const comments = gh(['-X', 'GET', `repos/${fullName}/issues/${issue.number}/comments`, '-f', 'per_page=100']);
      const timeline = gh(['-X', 'GET', `repos/${fullName}/issues/${issue.number}/timeline`, '-f', 'per_page=100']);
      records.push(evaluate({ issue, repo, comments, crossReferencedPrCount: countCrossRefPrs(timeline) }));
    } catch (e) {
      skipped++;
      console.error(`skip ${fullName}#${issue.number}: ${e.message}`);
    }
  }
  const sorted = sortRecords(records);
  const out = { generated_at: new Date().toISOString(), count: sorted.length, records: sorted };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of sorted) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`scan done: ${sorted.length} records (${skipped} skipped) | ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
