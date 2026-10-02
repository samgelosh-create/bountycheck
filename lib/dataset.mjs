// Bundled dataset (produced by scanner/scan.mjs). Static JSON import so Vercel's bundler includes it.
import data from '../data/claimable.json' with { type: 'json' };
import { computeStats, sortRecords } from './verdict.mjs';

export const generated_at = data.generated_at;
export const records = sortRecords(data.records || []);
export const stats = computeStats(records);

const index = new Map(records.map((r) => [r.issue.toLowerCase(), r]));
export const lookup = (key) => index.get(String(key).toLowerCase()) || null;

// The free sample deliberately shows flagged verdicts; the claimable shortlist is the paid part.
const SAMPLE_ORDER = ['not_real_money', 'contested', 'restricted', 'dead', 'unclear'];

/** 3 records, one per distinct verdict where possible. */
export function sample() {
  const picked = [];
  for (const v of SAMPLE_ORDER) {
    const r = records.find((x) => x.verdict === v);
    if (r) picked.push(r);
    if (picked.length === 3) return picked;
  }
  return picked;
}
