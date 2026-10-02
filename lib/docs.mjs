import { FOOTER, NETWORK, PAY_TO, PRICES, USDC_BASE } from './config.mjs';
import { STRIPE_LINK } from './private.mjs';

const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const CLAIMABLE_NOTE =
  '"claimable" means the issue passed every automated check (open, unassigned, real-money amount found, not a mirror, not already paid, fewer than two competing claims). It is a shortlist, not a guarantee of payment.';

/** Full human-readable report, served to card buyers at /report/<token>. */
export function reportHtml({ records, stats, generated_at }) {
  const row = (r) =>
    `<tr><td>${esc(r.verdict)}</td><td>${r.amount_usd === null ? '' : usd(r.amount_usd)}</td><td><a href="${esc(r.url)}">${esc(r.issue)}</a><br><small>${esc(r.title.slice(0, 110))}</small></td><td><small>${esc(r.reasons.join('; '))}</small></td><td>${r.signals.repo_stars ?? ''}</td><td>${r.signals.competing_prs}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>BountyCheck report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem;color:#111}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.3em .5em;text-align:left;vertical-align:top}small{color:#444}
footer{margin-top:2rem;color:#555;font-size:.9rem}</style></head><body>
<h1>BountyCheck report</h1>
<p>Thank you for buying. ${stats.record_count} open bounty issues scanned, generated ${esc(generated_at)}. Advertised total ${usd(stats.total_advertised_usd)}; ${stats.by_verdict.claimable} issues worth ${usd(stats.total_claimable_usd)} passed every automated check. Bookmark this page: it shows the newest dataset each time it is refreshed. JSON version: add <code>?format=json</code>.</p>
<p><small>${CLAIMABLE_NOTE}</small></p>
<table><tr><th>Verdict</th><th>Amount</th><th>Issue</th><th>Why</th><th>Repo stars</th><th>Competing PRs</th></tr>
${records.map(row).join('\n')}</table>
<footer>${FOOTER}</footer></body></html>`;
}

export function landingHtml({ stats, generated_at }) {
  const v = stats.by_verdict;
  const rows = Object.entries(v)
    .map(([k, n]) => `<tr><td>${k}</td><td>${n}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BountyCheck - claimability checks for GitHub bounties</title>
<meta name="description" content="Pay-per-call (x402, USDC on Base) API that tells bounty-hunting agents which open-source GitHub bounties are actually claimable.">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}
code,pre{background:#f3f3f3;border-radius:4px;padding:.1em .3em}pre{padding:.8em;overflow:auto}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25em .6em;text-align:left}footer{margin-top:2.5rem;color:#555;font-size:.9rem}</style>
</head><body>
<h1>BountyCheck</h1>
<p>Most open-source "bounty" issues on GitHub cannot actually be claimed: already paid, archived repo, assignee-only, test money, mirrors of someone else's issue, or swarmed by competing AI agents. BountyCheck scans fresh bounty issues and flags each one, so you (or your agent) stop spending hours and tokens on dead ones.</p>
<p><strong>Latest scan:</strong> ${stats.record_count} open bounty issues advertising ${usd(stats.total_advertised_usd)}. Only ${v.claimable} of them, worth ${usd(stats.total_claimable_usd)}, passed every automated check.</p>
<p><small>${CLAIMABLE_NOTE}</small></p>
${STRIPE_LINK ? `<h2>For humans: the full report, by card</h2>
<p><a href="${STRIPE_LINK}"><strong>Buy the full report for $5</strong></a> (Stripe checkout). You get a private page with every scanned issue, its verdict, the reasons, and the shortlist that passed, plus the same data as JSON. One-time payment, no account.</p>` : ''}
<h2>For agents: pay per call (x402)</h2>
<table><tr><th>Route</th><th>Price</th><th>Returns</th></tr>
<tr><td><code>GET /v1/claimable</code></td><td>${PRICES.claimable.display}</td><td>Full dataset, claimable first, then by amount</td></tr>
<tr><td><code>GET /v1/check?issue=owner/repo%23123</code></td><td>${PRICES.check.display}</td><td>One record (also accepts <code>?url=https://github.com/owner/repo/issues/123</code>)</td></tr></table>
<h2>How payment works</h2>
<pre>1. Call a paid route with no payment: you get HTTP 402 and a PAYMENT-REQUIRED header (network ${NETWORK}, USDC, pay-to ${PAY_TO}).
2. Sign a USDC (EIP-3009) payment for that amount with an x402 client and retry with the PAYMENT-SIGNATURE header.
3. The facilitator settles on Base only if the call succeeds (2xx); failed calls (4xx/5xx) are not charged.</pre>
<h2>Live stats (bundled dataset)</h2>
<p>${stats.record_count} issues scanned, generated ${generated_at}. Advertised total ${usd(stats.total_advertised_usd)}; in <code>claimable</code> verdicts only ${usd(stats.total_claimable_usd)}.</p>
<table><tr><th>Verdict</th><th>Count</th></tr>${rows}</table>
<h2>Free routes</h2>
<p><a href="/v1/sample">/v1/sample</a> (3 real records) &middot; <a href="/v1/stats">/v1/stats</a> &middot; <a href="/health">/health</a> &middot; <a href="/llms.txt">/llms.txt</a> &middot; <a href="/openapi.json">/openapi.json</a></p>
<footer>${FOOTER}</footer>
</body></html>`;
}

export function llmsTxt({ stats, generated_at }) {
  return `# BountyCheck

> Automated claimability checks for open-source GitHub bounty issues. Pay-per-call in USDC on Base via x402 (HTTP 402). ${FOOTER}

Dataset: ${stats.record_count} records, generated ${generated_at}. Verdicts: claimable, contested, restricted, not_real_money, dead, unclear.

## Free
- GET /health : liveness
- GET /v1/stats : counts by verdict, advertised USD vs USD in claimable verdicts
- GET /v1/sample : 3 real records (one per distinct verdict where possible)
- GET /openapi.json : OpenAPI 3.1 description

## Paid (x402 v2, scheme "exact", network ${NETWORK}, asset USDC ${USDC_BASE}, pay to ${PAY_TO})
- GET /v1/claimable : ${PRICES.claimable.display} (${PRICES.claimable.atomic} atomic units). Full dataset {generated_at,count,records[]}, claimable first then amount desc.
- GET /v1/check?issue=owner/repo%23123 : ${PRICES.check.display} (${PRICES.check.atomic} atomic units). One record. Also accepts ?url=https://github.com/owner/repo/issues/123. Served from the dataset when present, otherwise a live unauthenticated GitHub fetch (competing_prs is not computed live). 400 bad input, 404 not found, 502 GitHub unavailable.

## Payment flow
1. Request a paid route without payment. Response: 402 with a base64 PAYMENT-REQUIRED header and the same requirements in the JSON body.
2. Sign the payment with an x402 client (for example @x402/fetch) and retry with the PAYMENT-SIGNATURE header.
3. Settlement happens only after a successful (2xx) response. Error responses are not charged.

## Record shape
{issue, url, title, created_at, amount_usd|null, verdict, reasons[], signals:{state, repo_archived, repo_stars, repo_created_at, assignees[], comment_count, distinct_commenters, competing_prs, rewarded_marker, start_restricted, test_money, payout_address_comments}}

Data is machine-generated from public GitHub data; verify before you rely on it.
`;
}

const recordSchema = {
  type: 'object',
  properties: {
    issue: { type: 'string', example: 'owner/repo#123' },
    url: { type: 'string' },
    title: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    amount_usd: { type: ['number', 'null'] },
    verdict: { type: 'string', enum: ['claimable', 'contested', 'restricted', 'not_real_money', 'dead', 'unclear'] },
    reasons: { type: 'array', items: { type: 'string' } },
    signals: { type: 'object', additionalProperties: true },
  },
};

export function openapi(origin) {
  const paid = (price, atomic) => ({
    402: {
      description: `Payment required (x402 v2). PAYMENT-REQUIRED header and JSON body list: scheme exact, network ${NETWORK}, asset ${USDC_BASE}, amount ${atomic} (${price} USDC, 6 decimals), payTo ${PAY_TO}.`,
    },
  });
  return {
    openapi: '3.1.0',
    info: {
      title: 'BountyCheck',
      version: '0.1.0',
      description: `Automated claimability checks for GitHub bounty issues, paid per call in USDC on Base via x402. ${FOOTER}`,
      license: { name: 'MIT' },
    },
    servers: origin ? [{ url: origin }] : [],
    paths: {
      '/health': { get: { summary: 'Liveness', responses: { 200: { description: '{ok:true, generated_at}' } } } },
      '/v1/stats': { get: { summary: 'Counts by verdict and USD totals', responses: { 200: { description: 'Stats' } } } },
      '/v1/sample': { get: { summary: 'Three real records', responses: { 200: { description: 'Sample records' } } } },
      '/llms.txt': { get: { summary: 'Plain-text description for agents', responses: { 200: { description: 'text/plain' } } } },
      '/v1/claimable': {
        get: {
          summary: `Full dataset (${PRICES.claimable.display} USDC)`,
          'x-payment-info': { protocol: 'x402', scheme: 'exact', network: NETWORK, asset: USDC_BASE, amount: PRICES.claimable.atomic, payTo: PAY_TO },
          responses: {
            200: {
              description: '{generated_at, count, records[]} sorted claimable first, then amount desc',
              content: { 'application/json': { schema: { type: 'object', properties: { generated_at: { type: 'string' }, count: { type: 'integer' }, records: { type: 'array', items: recordSchema } } } } },
            },
            ...paid(PRICES.claimable.display, PRICES.claimable.atomic),
          },
        },
      },
      '/v1/check': {
        get: {
          summary: `One issue verdict (${PRICES.check.display} USDC)`,
          'x-payment-info': { protocol: 'x402', scheme: 'exact', network: NETWORK, asset: USDC_BASE, amount: PRICES.check.atomic, payTo: PAY_TO },
          parameters: [
            { name: 'issue', in: 'query', schema: { type: 'string' }, description: 'owner/repo#123 (URL-encode # as %23)' },
            { name: 'url', in: 'query', schema: { type: 'string' }, description: 'https://github.com/owner/repo/issues/123 (alternative to issue)' },
          ],
          responses: {
            200: { description: 'One record plus "source": "dataset" | "live"', content: { 'application/json': { schema: recordSchema } } },
            400: { description: 'Bad input (not charged)' },
            404: { description: 'Issue not found (not charged)' },
            502: { description: 'GitHub unreachable or rate-limited (not charged)' },
            ...paid(PRICES.check.display, PRICES.check.atomic),
          },
        },
      },
    },
  };
}
