// Entry point. Vercel's zero-config Hono preset detects src/index.js and its default-exported app;
// locally, src/dev.js serves the same app with @hono/node-server.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { FACILITATOR_URL, NETWORK, PAY_TO, PRICES, USDC_BASE } from '../lib/config.mjs';
import { generated_at, records, stats, lookup, sample } from '../lib/dataset.mjs';
import { liveCheck, GithubError } from '../lib/github.mjs';
import { parseIssueRef } from '../lib/ref.mjs';
import { landingHtml, llmsTxt, openapi, reportHtml } from '../lib/docs.mjs';
import { REPORT_TOKEN } from '../lib/private.mjs';

const app = new Hono();

app.use('*', cors({ origin: '*', exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'] }));

// ---- x402 seller middleware -------------------------------------------------
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  NETWORK,
  new ExactEvmScheme(),
);

const accepts = (price) => [{ scheme: 'exact', price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }];

// x402 v2 carries the authoritative requirements in the PAYMENT-REQUIRED header; the body mirrors them for humans.
const unpaid = (price) => () => ({
  contentType: 'application/json',
  body: {
    error: 'payment_required',
    x402Version: 2,
    accepts: [{ scheme: 'exact', network: NETWORK, asset: USDC_BASE, amount: price.atomic, payTo: PAY_TO }],
    note: 'Authoritative requirements are in the PAYMENT-REQUIRED response header (base64 JSON). Pay with an x402 client and retry with PAYMENT-SIGNATURE.',
    docs: '/llms.txt',
  },
});

const sampleRecord = sample()[0] || {};

const routes = {
  'GET /v1/claimable': {
    accepts: accepts(PRICES.claimable.display),
    description:
      'Full BountyCheck dataset: automated claimability verdicts for open GitHub bounty issues, claimable first then by amount desc.',
    mimeType: 'application/json',
    unpaidResponseBody: unpaid(PRICES.claimable),
    extensions: {
      ...declareDiscoveryExtension({
        output: { example: { generated_at, count: 1, records: [sampleRecord] } },
      }),
    },
  },
  'GET /v1/check': {
    accepts: accepts(PRICES.check.display),
    description:
      'Claimability verdict for one GitHub bounty issue (claimable, contested, restricted, not_real_money, dead). Pass ?issue=owner/repo%23123 or ?url=https://github.com/owner/repo/issues/123.',
    mimeType: 'application/json',
    unpaidResponseBody: unpaid(PRICES.check),
    extensions: {
      ...declareDiscoveryExtension({
        input: { issue: 'owner/repo#123' },
        inputSchema: {
          properties: {
            issue: { type: 'string', description: 'owner/repo#123 (URL-encode # as %23)' },
            url: { type: 'string', description: 'https://github.com/owner/repo/issues/123 (alternative to issue)' },
          },
        },
        output: { example: { ...sampleRecord, source: 'dataset' } },
      }),
    },
  },
};

// Settlement runs only after the handler returns; the middleware skips settlement for status >= 400.
app.use(paymentMiddleware(routes, resourceServer));

// ---- free routes ------------------------------------------------------------
const cache = (c, s = 300) => c.header('Cache-Control', `public, max-age=${s}`);

app.get('/', (c) => {
  cache(c);
  return c.html(landingHtml({ stats, generated_at }));
});
app.get('/health', (c) => c.json({ ok: true, generated_at }));
app.get('/v1/stats', (c) => {
  cache(c);
  return c.json({ generated_at, ...stats });
});
app.get('/v1/sample', (c) => {
  cache(c);
  return c.json({ generated_at, records: sample() });
});
app.get('/llms.txt', (c) => {
  cache(c);
  return c.text(llmsTxt({ stats, generated_at }));
});
app.get('/openapi.json', (c) => {
  cache(c);
  return c.json(openapi(new URL(c.req.url).origin));
});

// ---- paid routes ------------------------------------------------------------
app.get('/v1/claimable', (c) => c.json({ generated_at, count: records.length, records }));

app.get('/v1/check', async (c) => {
  const ref = parseIssueRef({ issue: c.req.query('issue'), url: c.req.query('url') });
  if (!ref) {
    return c.json(
      { error: 'bad_input', hint: 'Use ?issue=owner/repo%23123 or ?url=https://github.com/owner/repo/issues/123' },
      400,
    );
  }
  const hit = lookup(ref.key);
  if (hit) return c.json({ ...hit, source: 'dataset', data_generated_at: generated_at });
  try {
    const rec = await liveCheck(ref);
    return c.json({ ...rec, source: 'live' });
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.kind === 'bad_input') return c.json({ error: 'bad_input', message: e.message }, 400);
      if (e.kind === 'not_found') return c.json({ error: 'not_found', message: e.message }, 404);
      return c.json({ error: 'upstream_unavailable', message: e.message }, 502);
    }
    return c.json({ error: 'upstream_unavailable' }, 502);
  }
});

// ---- search indexing (no account needed) -------------------------------------
const INDEXNOW_KEY = 'df535a04286b3768db38769e63d2e8da';
const SITE = 'https://bountycheck.vercel.app';
app.get('/robots.txt', (c) => c.text(`User-agent: *
Allow: /
Disallow: /report/
Sitemap: ${SITE}/sitemap.xml
`));
app.get('/sitemap.xml', (c) => {
  const urls = ['/', '/llms.txt', '/openapi.json', '/v1/stats', '/v1/sample'];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
    .map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${generated_at.slice(0, 10)}</lastmod></url>`)
    .join('\n')}
</urlset>
`;
  return c.body(body, 200, { 'Content-Type': 'application/xml' });
});
app.get(`/${INDEXNOW_KEY}.txt`, (c) => c.text(INDEXNOW_KEY));
// 402index.io domain claim (public hash, not the claim token).
app.get('/.well-known/402index-verify.txt', (c) =>
  c.text('1e3883ca69930dacaba0e6ab685e9fdf0838c8c145c743da3c41116c6cd831f1'),
);

// ---- card buyers: Stripe redirects here after payment -------------------------
app.get('/report/:token', (c) => {
  if (!REPORT_TOKEN || c.req.param('token') !== REPORT_TOKEN) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex');
  if (c.req.query('format') === 'json') return c.json({ generated_at, count: records.length, records });
  return c.html(reportHtml({ records, stats, generated_at }));
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
