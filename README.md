# BountyCheck

Most open-source "bounty" issues on GitHub cannot actually be claimed: already paid, archived repo, assignee-only, test money, mirrors of someone else's issue, or swarmed by competing AI agents. BountyCheck scans fresh bounty issues and flags each one, so you (or your agent) stop spending hours and tokens on dead ones.

Live: **https://bountycheck.vercel.app**

Scan of 2026-10-02: 150 open bounty issues advertising about $55,000. Only 8 of them, worth $826, passed every automated check.

## Routes

| Route | Price | Returns |
|---|---|---|
| `GET /v1/stats` | free | counts by verdict, advertised vs shortlisted USD |
| `GET /v1/sample` | free | 3 real records |
| `GET /llms.txt`, `GET /openapi.json` | free | machine-readable docs |
| `GET /v1/check?issue=owner/repo%23123` | $0.02 USDC | one record (also `?url=https://github.com/owner/repo/issues/123`) |
| `GET /v1/claimable` | $0.05 USDC | full dataset, shortlist first |

Humans can buy the full report by card from the landing page (Stripe checkout, one-time).

Paid routes use [x402](https://x402.org) v2: scheme `exact`, USDC on Base (`eip155:8453`). No account, no API key.

```bash
curl -i https://bountycheck.vercel.app/v1/claimable
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 JSON: network eip155:8453, asset USDC, amount 50000, payTo 0x3D61...4B4A>
```

Pay with any x402 client (for example `@x402/fetch`) and retry with the `PAYMENT-SIGNATURE` header. Settlement happens only after a 2xx response; error responses are not charged.

## Verdicts

First match wins: `dead` (closed, archived, already rewarded), `not_real_money` (devnet, testnet, points), `unclear` (mirror or aggregator issue, reward only proposed, no amount found), `restricted` (assigned, reserved, collaborator-only), `contested` (two or more competing PRs or claims, or 15+ comments), `claimable`.

`claimable` means the issue passed every automated check. It is a shortlist, not a guarantee of payment. Each record carries its `reasons` and raw `signals` so you can judge for yourself.

## How the data is produced

`scanner/scan.mjs` runs GitHub issue searches for bounty labels and markers (open, created in the last 30 days), then fetches each issue's repository, comments and timeline. `lib/verdict.mjs` is a pure function over that data, covered by `npm test`. No LLM is involved in the verdicts.

```bash
npm install
npm test
npm run scan   # needs an authenticated gh CLI
npm run dev    # http://localhost:8799
```

This public repository ships a 3-record sample dataset; the live service serves the full one.

## Disclosure

Built and operated by an autonomous AI agent (Claude) for Sam Gelosh. Data is machine-generated from public GitHub data; verify before you rely on it.

MIT licensed.
