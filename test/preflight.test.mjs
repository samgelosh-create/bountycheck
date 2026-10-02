import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze402, validateTarget, isBlockedAddress, preflight, preflightSafe } from '../lib/preflight.mjs';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYTO = '0x' + 'ab'.repeat(20);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const accept = (over = {}) => ({ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '10000', payTo: PAYTO, maxTimeoutSeconds: 60, ...over });
const v2 = (over = {}) => ({ x402Version: 2, resource: { url: 'https://api.example.com/v1/thing' }, accepts: [accept()], extensions: { bazaar: {} }, ...over });
const URL_ = 'https://api.example.com/v1/thing';

test('analyze402: valid v2 header', () => {
  const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2()) }, bodyText: '', requestedUrl: URL_ });
  assert.equal(r.is_x402, true);
  assert.equal(r.x402_version, 2);
  assert.equal(r.header_present, true);
  assert.equal(r.has_bazaar_extension, true);
  assert.equal(r.resource_url, URL_);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, []);
  assert.equal(r.accepts.length, 1);
  assert.deepEqual(r.accepts[0], { scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '10000', payTo: PAYTO, max_timeout_seconds: 60, price_usd: 0.01 });
});

test('analyze402: price_usd only for USDC on Base', () => {
  const lower = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ asset: USDC.toLowerCase() })] })) }, requestedUrl: URL_ });
  assert.equal(lower.accepts[0].price_usd, 0.01);
  const other = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ asset: '0x' + '11'.repeat(20) })] })) }, requestedUrl: URL_ });
  assert.equal(other.accepts[0].price_usd, null);
  const otherNet = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ network: 'eip155:1' })] })) }, requestedUrl: URL_ });
  assert.equal(otherNet.accepts[0].price_usd, null);
});

test('analyze402: valid v1 body', () => {
  const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', asset: USDC, maxAmountRequired: '5000', payTo: PAYTO, resource: URL_ }] });
  const r = analyze402({ status: 402, headers: {}, bodyText: body, requestedUrl: URL_ });
  assert.equal(r.is_x402, true);
  assert.equal(r.x402_version, 1);
  assert.equal(r.header_present, false);
  assert.equal(r.accepts[0].amount, '5000');
  assert.equal(r.accepts[0].price_usd, 0.005);
  assert.equal(r.resource_url, URL_);
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.includes('v1 only (legacy)'));
  assert.ok(r.notes.includes('no bazaar discovery extension'));
});

test('analyze402: 200 response is not x402', () => {
  const r = analyze402({ status: 200, headers: {}, bodyText: '{"ok":true}', requestedUrl: URL_ });
  assert.equal(r.is_x402, false);
  assert.equal(r.status, 200);
  assert.ok(r.problems.some((p) => /not 402|expected 402/.test(p)));
  assert.ok(r.problems.some((p) => /no payment-required header/.test(p)));
});

test('analyze402: malformed base64 and bad JSON', () => {
  const a = analyze402({ status: 402, headers: { 'payment-required': '%%%not base64%%%' }, bodyText: '', requestedUrl: URL_ });
  assert.equal(a.is_x402, false);
  assert.equal(a.header_present, true);
  assert.ok(a.problems.some((p) => /not valid base64 JSON/.test(p)));
  const b = analyze402({ status: 402, headers: { 'payment-required': Buffer.from('not json').toString('base64') }, requestedUrl: URL_ });
  assert.ok(b.problems.some((p) => /not valid base64 JSON/.test(p)));
  const c = analyze402({ status: 402, headers: { 'payment-required': Buffer.from('[1,2]').toString('base64') }, requestedUrl: URL_ });
  assert.ok(c.problems.some((p) => /not valid base64 JSON/.test(p)));
});

test('analyze402: empty accepts', () => {
  const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [] })) }, requestedUrl: URL_ });
  assert.equal(r.is_x402, false);
  assert.ok(r.problems.some((p) => /accepts is missing or empty/.test(p)));
});

test('analyze402: bad amount and missing fields', () => {
  const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ amount: '1.5' }), accept({ amount: -3 }), accept({ payTo: undefined })] })) }, requestedUrl: URL_ });
  assert.equal(r.problems.filter((p) => /amount is not a non-negative integer string/.test(p)).length, 2);
  assert.ok(r.problems.some((p) => /accept 3 is missing/.test(p)));
  assert.equal(r.accepts[0].price_usd, null);
  assert.ok(r.notes.some((n) => /more than one accept/.test(n)));
});

test('analyze402: bad payTo on eip155 network', () => {
  const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ payTo: '0x1234' })] })) }, requestedUrl: URL_ });
  assert.ok(r.problems.some((p) => /payTo is not a 0x 20-byte address/.test(p)));
  const sol = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ network: 'solana:abc', payTo: 'SomeBase58Address' })] })) }, requestedUrl: URL_ });
  assert.ok(!sol.problems.some((p) => /payTo/.test(p)));
});

test('analyze402: host mismatch and http resource', () => {
  const m = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ resource: { url: 'https://other.example.org/x' } })) }, requestedUrl: URL_ });
  assert.ok(m.problems.some((p) => /host .* differs/.test(p)));
  const h = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ resource: { url: 'http://api.example.com/v1/thing' } })) }, requestedUrl: URL_ });
  assert.ok(h.problems.some((p) => /uses http/.test(p)));
  assert.ok(!h.problems.some((p) => /differs/.test(p)));
});

test('analyze402: never throws on junk input', () => {
  assert.doesNotThrow(() => analyze402());
  assert.doesNotThrow(() => analyze402({ status: 402, headers: null, bodyText: null }));
  const r = analyze402({ status: 402, headers: {}, bodyText: '{"accepts":[null,"x",5]}', requestedUrl: 'not a url' });
  assert.equal(r.accepts.length, 3);
});

test('validateTarget', () => {
  const bad = (u, re) => {
    const r = validateTarget(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.url, null);
    if (re) assert.match(r.reason, re);
  };
  bad('http://api.example.com/x', /https/);
  bad('https://user:pw@api.example.com/x', /credentials/);
  bad('https://api.example.com:8080/x', /port/);
  bad('https://localhost/x');
  bad('https://foo.local/x');
  bad('https://db.internal/x');
  bad('https://a.localhost/x');
  bad('https://127.0.0.1/x', /private|reserved/);
  bad('https://10.0.0.5/x');
  bad('https://169.254.169.254/latest/meta-data');
  bad('https://[::1]/x');
  bad('https://[::ffff:127.0.0.1]/x');
  bad('https://[::ffff:0:127.0.0.1]/x');
  bad('https://[64:ff9b:1::7f00:1]/x');
  bad('https://2130706433/x');
  bad('https://bountycheck.vercel.app/v1/x402/preflight', /itself/);
  bad('https://BountyCheck.Vercel.App./x');
  bad('ftp://example.com/x');
  bad('not a url');
  bad('');
  const custom = validateTarget('https://mine.example.com/x', { selfHosts: ['mine.example.com'] });
  assert.equal(custom.ok, false);
  const good = validateTarget('https://api.example.com:443/v1/thing?a=1');
  assert.equal(good.ok, true);
  assert.equal(good.url, 'https://api.example.com/v1/thing?a=1');
  assert.equal(good.reason, null);
  assert.equal(validateTarget('https://8.8.8.8/x').ok, true);
  assert.equal(validateTarget('https://[2606:4700:4700::1111]/x').ok, true);
});

test('isBlockedAddress table', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.0.9',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', 'ff00::',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:a00:5', '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip',
    '::ffff:0:127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:8.8.8.8', '64:ff9b:1::7f00:1', '64:ff9b:1:ffff::1',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '2001:db8:ffff::1', '100::1', '100::ffff:1',
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  const open = [
    '1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.167.1.1',
    '198.17.255.255', '198.20.0.1', '223.255.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', 'fbff::1', 'fec0::1',
    '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2001:1::1', '2001:db9::1', '100:0:0:1::1', '64:ff9b:2::1',
  ];
  for (const ip of open) assert.equal(isBlockedAddress(ip), false, ip);
});

// ---------- preflight with injected I/O ----------

const okLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const mkRes = (status, headers, body) => new Response(body ?? null, { status, headers });
const challenge = () => mkRes(402, { 'payment-required': b64(v2()), 'content-type': 'application/json' }, '{}');

test('preflight: happy path', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return challenge();
  };
  const r = await preflight('https://api.example.com/v1/thing', { fetchImpl, lookupImpl: okLookup });
  assert.equal(seen.url, 'https://api.example.com/v1/thing');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers['user-agent'], 'BountyCheck-preflight/1.0');
  assert.ok(seen.init.signal);
  assert.equal(r.reachable, true);
  assert.equal(r.is_x402, true);
  assert.equal(r.status, 402);
  assert.equal(r.accepts[0].price_usd, 0.01);
  assert.deepEqual(r.problems, []);
  assert.equal(typeof r.latency_ms, 'number');
  assert.ok(!Number.isNaN(Date.parse(r.checked_at)));
  assert.ok(!('body' in r) && !('bodyText' in r));
});

test('preflight: blocked DNS answer refuses (any address)', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return challenge();
  };
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(preflight('https://api.example.com/x', { fetchImpl, lookupImpl }), (e) => e.code === 'bad_target' && /private or reserved/.test(e.message));
  assert.equal(fetched, false);
  const mapped = async () => [{ address: '::ffff:10.0.0.1', family: 6 }];
  await assert.rejects(preflight('https://api.example.com/x', { fetchImpl, lookupImpl: mapped }), (e) => e.code === 'bad_target');
});

test('preflight: bad targets throw bad_target', async () => {
  for (const u of ['http://api.example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'junk']) {
    await assert.rejects(preflight(u, { fetchImpl: async () => challenge(), lookupImpl: okLookup }), (e) => e.code === 'bad_target' && e.message.length > 0, u);
  }
});

test('preflight: DNS failure and network error do not throw', async () => {
  const dnsFail = await preflight('https://nx.example.com/x', { fetchImpl: async () => challenge(), lookupImpl: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); } });
  assert.equal(dnsFail.reachable, false);
  assert.match(dnsFail.problems[0], /DNS lookup failed/);
  const netFail = await preflight('https://api.example.com/x', { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); }, lookupImpl: okLookup });
  assert.equal(netFail.reachable, false);
  assert.match(netFail.problems[0], /request failed: connect ECONNREFUSED/);
});

test('preflight: timeout returns reachable:false', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const r = await preflight('https://slow.example.com/x', { fetchImpl, lookupImpl: okLookup, timeoutMs: 30 });
  assert.equal(r.reachable, false);
  assert.equal(r.is_x402, false);
  assert.match(r.problems[0], /timed out after 30ms/);
});

test('preflight: redirect is reported and not followed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mkRes(302, { location: 'https://elsewhere.example.com/pay' }, '');
  };
  const r = await preflight('https://api.example.com/x', { fetchImpl, lookupImpl: okLookup });
  assert.equal(calls, 1);
  assert.equal(r.reachable, true);
  assert.equal(r.status, 302);
  assert.equal(r.is_x402, false);
  assert.ok(r.problems.includes('redirects to https://elsewhere.example.com/pay'));
});

test('preflight: body over maxBytes is truncated without error', async () => {
  let cancelled = false;
  let pulled = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(enc.encode('x'.repeat(1000)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async () => new Response(stream, { status: 402, headers: { 'payment-required': b64(v2()) } });
  const r = await preflight('https://api.example.com/x', { fetchImpl, lookupImpl: okLookup, maxBytes: 2500 });
  assert.equal(r.reachable, true);
  assert.equal(r.is_x402, true); // header still decoded
  assert.equal(cancelled, true);
  assert.ok(pulled >= 3 && pulled < 10, `pulled ${pulled}`);
});

test('preflight: v1 JSON body within limit is parsed; truncated JSON is not x402', async () => {
  const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', asset: USDC, maxAmountRequired: '10000', payTo: PAYTO }] });
  const ok = await preflight('https://api.example.com/x', { fetchImpl: async () => mkRes(402, {}, body), lookupImpl: okLookup });
  assert.equal(ok.is_x402, true);
  assert.equal(ok.x402_version, 1);
  const cut = await preflight('https://api.example.com/x', { fetchImpl: async () => mkRes(402, {}, body), lookupImpl: okLookup, maxBytes: 20 });
  assert.equal(cut.reachable, true);
  assert.equal(cut.is_x402, false);
});

// ---------- review fixes ----------

test('preflight: a stalled DNS lookup is bounded by timeoutMs', async () => {
  let fetched = false;
  const t0 = Date.now();
  const r = await preflight('https://api.example.com/x', {
    lookupImpl: () => new Promise(() => {}),
    fetchImpl: async () => {
      fetched = true;
      return challenge();
    },
    timeoutMs: 100,
  });
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0));
  assert.equal(r.reachable, false);
  assert.match(r.problems[0], /DNS lookup timed out after 100ms/);
  assert.equal(fetched, false);
});

test('preflight: lookup and fetch share one deadline', async () => {
  const slowLookup = () => new Promise((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 120));
  const fetchImpl = () => new Promise(() => {}); // ignores the abort signal entirely
  const t0 = Date.now();
  const r = await preflight('https://api.example.com/x', { lookupImpl: slowLookup, fetchImpl, timeoutMs: 200 });
  const took = Date.now() - t0;
  assert.ok(took < 330, 'took ' + took); // 200 total, not 120 + 200
  assert.equal(r.reachable, false);
  assert.match(r.problems[0], /timed out after 200ms/);
});

test('preflight: fetchImpl returning nothing does not throw', async () => {
  for (const bad of [undefined, null]) {
    const r = await preflight('https://api.example.com/x', { fetchImpl: async () => bad, lookupImpl: okLookup });
    assert.equal(r.reachable, false);
    assert.match(r.problems[0], /request failed/);
  }
});

test('preflightSafe: bad_target maps to 400, other errors to reachable:false, never throws', async () => {
  const bad = await preflightSafe('http://api.example.com/x', { lookupImpl: okLookup });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_target');
  const priv = await preflightSafe('https://api.example.com/x', { lookupImpl: async () => [{ address: '10.0.0.1', family: 4 }] });
  assert.equal(priv.status, 400);
  assert.match(priv.body.reason, /private or reserved/);
  const boom = await preflightSafe('https://api.example.com/x', { lookupImpl: okLookup, fetchImpl: () => { throw new TypeError('kaboom'); } });
  assert.equal(boom.status, 200);
  assert.equal(boom.body.reachable, false);
  const ok = await preflightSafe('https://api.example.com/v1/thing', { lookupImpl: okLookup, fetchImpl: async () => challenge() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.is_x402, true);
});

test('analyze402: attacker-controlled strings are clipped, accepts capped, resource_url limited to http(s)', () => {
  const evil = analyze402({
    status: 402,
    headers: {},
    bodyText: JSON.stringify({
      x402Version: 2,
      resource: 'javascript:alert(1)//' + 'A'.repeat(60000),
      accepts: Array.from({ length: 300 }, () => accept({ payTo: '<img src=x onerror=alert(1)>' + 'B'.repeat(5000), scheme: '<script>' + 'C'.repeat(5000), network: 'N'.repeat(5000), asset: 'D'.repeat(5000), amount: '9'.repeat(400) })),
    }),
    requestedUrl: URL_,
  });
  assert.equal(evil.resource_url, null);
  assert.ok(evil.problems.some((p) => /not an http\(s\) URL/.test(p)));
  assert.equal(evil.accepts.length, 10);
  assert.ok(evil.problems.some((p) => /300 entries; only the first 10/.test(p)));
  for (const a of evil.accepts) {
    for (const k of ['scheme', 'network', 'asset', 'amount', 'payTo']) assert.ok(a[k].length <= 103, `${k} ${a[k].length}`);
    assert.equal(a.price_usd, null);
  }
  assert.ok(JSON.stringify(evil).length < 12000, 'result size ' + JSON.stringify(evil).length);
  for (const bad of ['data:text/html,<script>1</script>', 'ftp://api.example.com/x', '/relative/path', 'vbscript:x']) {
    const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ resource: { url: bad } })) }, requestedUrl: URL_ });
    assert.equal(r.resource_url, null, bad);
    assert.ok(r.problems.some((p) => /not an http\(s\) URL/.test(p)), bad);
  }
  const long = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ resource: { url: 'https://api.example.com/' + 'a'.repeat(5000) } })) }, requestedUrl: URL_ });
  assert.ok(long.resource_url.length <= 203);
});

test('analyze402: price_usd is never Infinity or NaN', () => {
  const r = analyze402({ status: 402, headers: { 'payment-required': b64(v2({ accepts: [accept({ amount: '9'.repeat(400) })] })) }, requestedUrl: URL_ });
  assert.equal(r.accepts[0].price_usd, null);
  assert.ok(!JSON.stringify(r).includes('Infinity'));
});
