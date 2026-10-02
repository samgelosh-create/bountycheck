// x402 endpoint preflight: checks whether a URL returns a well-formed x402 payment challenge.
// analyze402 is pure; preflight performs one guarded GET (SSRF-checked, no redirects, size/time capped).
// SECURITY: every field in the result that came from the probed server (resource_url, accepts[*], problems) is
// UNTRUSTED DATA. Strings are length-clipped and resource_url is limited to http(s), but values are not HTML-safe.
// Render them as text only; never inject them into HTML, markup or a link without escaping.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const UA = 'BountyCheck-preflight/1.0';
const MAX_TEXT = 200;
const MAX_FIELD = 100; // clip for echoed accept fields
const MAX_ACCEPTS = 10;

const clip = (s, n = MAX_TEXT) => {
  const t = String(s ?? '').replace(/[\r\n\t]+/g, ' ');
  return t.length > n ? t.slice(0, n) + '...' : t;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

// ---------- IP range checks ----------

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

function parseIPv6(input) {
  let s = input.toLowerCase();
  const z = s.indexOf('%');
  if (z >= 0) s = s.slice(0, z);
  if (!s.includes(':')) return null;
  // embedded dotted IPv4 tail
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

function blockedV4(o) {
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10
  if (a === 127) return true; // 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const v4 = parseIPv4(s);
  if (v4) return blockedV4(v4);
  const b = parseIPv6(s);
  if (!b) return true; // not a parseable IP: fail closed
  const first80Zero = b.slice(0, 10).every((x) => x === 0);
  if (first80Zero && b[10] === 0 && b[11] === 0) {
    // :: , ::1 and IPv4-compatible ::a.b.c.d
    return true;
  }
  if (first80Zero && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12)); // IPv4-mapped
  // IPv4-translated ::ffff:0:0:0/96 (SIIT): blocked outright
  if (b.slice(0, 8).every((x) => x === 0) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true;
  // NAT64 local-use 64:ff9b:1::/48: blocked outright
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return true;
  // 100::/64 discard-only
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true;
  // Teredo 2001::/32 and documentation 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0x00 && b[3] === 0x00) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // NAT64 64:ff9b::/96 embeds an IPv4 address
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return blockedV4(b.slice(12));
  }
  // 6to4 2002::/16 embeds an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6));
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (b[0] === 0xff) return true; // ff00::/8
  return false;
}

// ---------- target validation ----------

export function validateTarget(urlString, { selfHosts = ['bountycheck.vercel.app'] } = {}) {
  const bad = (reason) => ({ ok: false, url: null, reason });
  if (typeof urlString !== 'string' || !urlString.trim()) return bad('url is required');
  let u;
  try {
    u = new URL(urlString.trim());
  } catch {
    return bad('url is not a valid absolute URL');
  }
  if (u.protocol !== 'https:') return bad('only https URLs are allowed');
  if (u.username || u.password) return bad('URLs with credentials are not allowed');
  if (u.port !== '' && u.port !== '443') return bad('only the default https port (443) is allowed');
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return bad('url has no hostname');
  const selves = (selfHosts || []).map((h) => String(h).toLowerCase());
  if (selves.includes(host)) return bad('this service cannot preflight itself');
  if (host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) return bad('local and internal hostnames are not allowed');
  if (isIP(host) && isBlockedAddress(host)) return bad('private or reserved IP addresses are not allowed');
  return { ok: true, url: u.toString(), reason: null };
}

// ---------- pure analysis ----------

function decodeHeaderPayload(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  try {
    const obj = JSON.parse(Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return isObj(obj) ? obj : null;
  } catch {
    return null;
  }
}

function parseBodyPayload(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return null;
  try {
    const obj = JSON.parse(bodyText);
    return isObj(obj) && 'accepts' in obj ? obj : null;
  } catch {
    return null;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function priceUsd(a) {
  if (!nonEmptyStr(a.asset) || a.asset.toLowerCase() !== USDC_BASE) return null;
  if (a.network !== 'eip155:8453' && a.network !== 'base') return null;
  if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount)) return null;
  const usd = Number(a.amount) / 1e6;
  return Number.isFinite(usd) ? usd : null;
}

// http(s) URLs only; anything else (javascript:, data:, relative) is rejected.
function safeResourceUrl(candidate) {
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function analyze402({ status, headers, bodyText, requestedUrl } = {}) {
  const problems = [];
  const notes = [];
  const hdrs = isObj(headers) ? headers : {};
  const headerRaw = hdrs['payment-required'];
  const header_present = headerRaw !== undefined && headerRaw !== null;

  if (status !== 402) problems.push(`status is ${status ?? 'unknown'}, expected 402`);

  let payload = null;
  let headerBad = false;
  if (header_present) {
    payload = decodeHeaderPayload(headerRaw);
    if (!payload) {
      headerBad = true;
      problems.push('payment-required header is not valid base64 JSON');
    }
  }
  if (!payload) payload = parseBodyPayload(bodyText);
  if (!payload && !headerBad) problems.push('no payment-required header and no accepts in the body');

  const rawAccepts = payload && Array.isArray(payload.accepts) ? payload.accepts : null;
  if (payload && (!rawAccepts || rawAccepts.length === 0)) problems.push('accepts is missing or empty');

  const accepts = [];
  if (rawAccepts && rawAccepts.length > MAX_ACCEPTS) {
    problems.push(`accepts has ${rawAccepts.length} entries; only the first ${MAX_ACCEPTS} are analyzed`);
  }
  (rawAccepts || []).slice(0, MAX_ACCEPTS).forEach((raw, i) => {
    const r = isObj(raw) ? raw : {};
    const amountRaw = r.amount !== undefined ? r.amount : r.maxAmountRequired; // v1 name
    const timeout = r.maxTimeoutSeconds !== undefined ? r.maxTimeoutSeconds : r.max_timeout_seconds;
    const a = {
      scheme: nonEmptyStr(r.scheme) ? r.scheme : null,
      network: nonEmptyStr(r.network) ? r.network : null,
      asset: nonEmptyStr(r.asset) ? r.asset : null,
      amount: typeof amountRaw === 'string' || typeof amountRaw === 'number' ? amountRaw : null,
      payTo: nonEmptyStr(r.payTo) ? r.payTo : null,
      max_timeout_seconds: typeof timeout === 'number' ? timeout : null,
      price_usd: null,
    };
    const n = i + 1;
    if (!a.scheme || !a.network || a.amount === null || !a.payTo) {
      problems.push(`accept ${n} is missing scheme, network, amount or payTo`);
    }
    if (a.amount !== null && !(typeof a.amount === 'string' && /^\d+$/.test(a.amount))) {
      problems.push(`accept ${n} amount is not a non-negative integer string`);
    }
    if (a.network && a.network.startsWith('eip155:') && a.payTo && !/^0x[0-9a-fA-F]{40}$/.test(a.payTo)) {
      problems.push(`accept ${n} payTo is not a 0x 20-byte address`);
    }
    a.price_usd = priceUsd(a); // computed from the full values, before clipping
    accepts.push({
      ...a,
      scheme: a.scheme === null ? null : clip(a.scheme, MAX_FIELD),
      network: a.network === null ? null : clip(a.network, MAX_FIELD),
      asset: a.asset === null ? null : clip(a.asset, MAX_FIELD),
      amount: typeof a.amount === 'string' ? clip(a.amount, MAX_FIELD) : a.amount,
      payTo: a.payTo === null ? null : clip(a.payTo, MAX_FIELD),
    });
  });

  const version = payload && typeof payload.x402Version === 'number' ? payload.x402Version : null;

  let resource_url = null;
  if (payload) {
    if (isObj(payload.resource) && nonEmptyStr(payload.resource.url)) resource_url = payload.resource.url;
    else if (nonEmptyStr(payload.resource)) resource_url = payload.resource;
    else if (rawAccepts) {
      const withRes = rawAccepts.find((x) => isObj(x) && nonEmptyStr(x.resource)); // v1 puts it per accept
      if (withRes) resource_url = withRes.resource;
    }
  }
  if (resource_url) {
    const ru = safeResourceUrl(resource_url);
    if (!ru) {
      problems.push('resource.url is not an http(s) URL; ignored');
      resource_url = null;
    } else {
      const rh = ru.hostname.toLowerCase();
      const qh = requestedUrl ? hostOf(requestedUrl) : null;
      if (rh && qh && rh !== qh) problems.push(`resource.url host (${clip(rh, 100)}) differs from the requested host (${clip(qh, 100)})`);
      if (ru.protocol === 'http:') problems.push('resource.url uses http, not https');
      resource_url = clip(ru.href, MAX_TEXT);
    }
  }

  const extensions = payload && isObj(payload.extensions) ? payload.extensions : null;
  const has_bazaar_extension = !!(extensions && 'bazaar' in extensions);

  if (payload) {
    if (version === 1) notes.push('v1 only (legacy)');
    if (!has_bazaar_extension) notes.push('no bazaar discovery extension');
    if (accepts.length > 1) notes.push(`more than one accept (${accepts.length})`);
  }

  return {
    is_x402: status === 402 && accepts.length > 0,
    x402_version: version,
    status: status ?? null,
    header_present,
    accepts,
    resource_url,
    has_bazaar_extension,
    problems,
    notes,
  };
}

// ---------- network preflight ----------

function badTarget(reason) {
  const e = new Error(reason);
  e.code = 'bad_target';
  return e;
}

async function readLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = typeof res.text === 'function' ? await res.text() : '';
    return Buffer.from(t, 'utf8').subarray(0, maxBytes).toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const room = maxBytes - total;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.length, room);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function emptyResult(problem) {
  return {
    is_x402: false,
    x402_version: null,
    status: null,
    header_present: false,
    accepts: [],
    resource_url: null,
    has_bazaar_extension: false,
    problems: [problem],
    notes: [],
  };
}

export async function preflight(urlString, { fetchImpl = fetch, lookupImpl, timeoutMs = 5000, maxBytes = 65536, selfHosts } = {}) {
  const v = validateTarget(urlString, selfHosts ? { selfHosts } : undefined);
  if (!v.ok) throw badTarget(v.reason);
  const url = v.url;
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const checked_at = () => new Date().toISOString();

  // One overall deadline covers the DNS lookup, the fetch and the body read.
  const ctrl = new AbortController();
  let timedOut = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      reject(Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
  });
  deadline.catch(() => {}); // never an unhandled rejection
  const within = (p) => Promise.race([p, deadline]);

  try {
    if (!isIP(hostname)) {
      const doLookup = lookupImpl || ((h) => dnsLookup(h, { all: true }));
      let answers;
      try {
        answers = await within(Promise.resolve().then(() => doLookup(hostname, { all: true })));
      } catch (err) {
        const msg = timedOut ? `DNS lookup timed out after ${timeoutMs}ms` : `DNS lookup failed: ${clip(err && err.code ? err.code : err && err.message, 80)}`;
        return { url, reachable: false, latency_ms: null, ...emptyResult(msg), checked_at: checked_at() };
      }
      const list = (Array.isArray(answers) ? answers : [answers]).map((x) => (typeof x === 'string' ? x : x && x.address)).filter(Boolean);
      if (list.length === 0) {
        return { url, reachable: false, latency_ms: null, ...emptyResult('DNS lookup returned no addresses'), checked_at: checked_at() };
      }
      if (list.some((ip) => isBlockedAddress(ip))) throw badTarget('hostname resolves to a private or reserved address');
    }

    const t0 = Date.now();
    let res;
    try {
      res = await within(Promise.resolve().then(() => fetchImpl(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': UA } })));
    } catch (err) {
      const msg = timedOut || (err && err.name === 'AbortError') ? `request timed out after ${timeoutMs}ms` : `request failed: ${clip(err && err.message, 120)}`;
      return { url, reachable: false, latency_ms: Date.now() - t0, ...emptyResult(msg), checked_at: checked_at() };
    }
    const latency_ms = Date.now() - t0;
    if (!res || typeof res !== 'object') {
      return { url, reachable: false, latency_ms, ...emptyResult('request failed: no response object'), checked_at: checked_at() };
    }
    const headers = {};
    if (res.headers && typeof res.headers.forEach === 'function') res.headers.forEach((val, key) => (headers[String(key).toLowerCase()] = val));
    let bodyText = '';
    let bodyProblem = null;
    try {
      bodyText = await within(readLimited(res, maxBytes));
    } catch {
      bodyProblem = timedOut ? `response body timed out after ${timeoutMs}ms` : 'response body could not be read';
    }
    const result = analyze402({ status: res.status, headers, bodyText, requestedUrl: url });
    if (res.status >= 300 && res.status < 400) {
      result.problems.push(`redirects to ${clip(headers.location || 'unknown location', 200)}`);
    }
    if (bodyProblem) result.problems.push(bodyProblem);
    return { url, reachable: true, latency_ms, ...result, checked_at: checked_at() };
  } finally {
    clearTimeout(timer);
  }
}

// Never-throwing wrapper for route handlers. Returns { status, body }: status is the HTTP status the route should
// send, 400 for a bad target (including a hostname that resolves to a private address) and 200 otherwise.
// The caller must not settle the payment for non-2xx responses (the x402 middleware settles only below 400).
export async function preflightSafe(urlString, opts) {
  try {
    return { status: 200, body: await preflight(urlString, opts) };
  } catch (err) {
    if (err && err.code === 'bad_target') return { status: 400, body: { error: 'bad_target', reason: clip(err.message, 200) } };
    const body = { url: null, reachable: false, latency_ms: null, ...emptyResult(`preflight failed: ${clip(err && err.message, 120)}`), checked_at: new Date().toISOString() };
    return { status: 200, body };
  }
}
