import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseAmount, parseAmountFromText, sortRecords, computeStats } from '../lib/verdict.mjs';
import { parseIssueRef } from '../lib/ref.mjs';

const repo = { full_name: 'acme/widgets', owner: { login: 'acme' }, archived: false, stargazers_count: 42, created_at: '2020-01-01T00:00:00Z' };
const issue = (over = {}) => ({
  number: 7,
  title: 'Fix the widget [Bounty $100]',
  body: 'Please fix.',
  state: 'open',
  labels: [{ name: 'bounty' }],
  assignees: [],
  comments: 0,
  html_url: 'https://github.com/acme/widgets/issues/7',
  created_at: '2026-09-20T00:00:00Z',
  ...over,
});
const comment = (login, body, over = {}) => ({ body, user: { login, type: 'User' }, ...over });

test('amount parsing', () => {
  assert.equal(parseAmountFromText('Reward $1,000 for this'), 1000);
  assert.equal(parseAmountFromText('Price: 75 USD'), 75);
  assert.equal(parseAmountFromText('[Bounty $2k]'), 2000);
  assert.equal(parseAmountFromText('Pays 150 USDC on merge'), 150);
  assert.equal(parseAmountFromText('no money here, 3 apples'), null);
  assert.equal(parseAmountFromText('$0.50 is too small, then $75'), 75);
  assert.equal(parseAmountFromText('$999999 is implausible'), null);
  assert.equal(parseAmount({ title: 'x', labels: [{ name: '$200' }], body: '$5' }), 200);
  assert.equal(parseAmount({ title: 'x', labels: [], body: 'Price: 75 USD' }), 75);
  assert.equal(parseAmount({ title: 'nothing', labels: [], body: '' }), null);
});

test('claimable', () => {
  const r = evaluate({ issue: issue(), repo, comments: [], crossReferencedPrCount: 0 });
  assert.equal(r.verdict, 'claimable');
  assert.equal(r.amount_usd, 100);
  assert.equal(r.issue, 'acme/widgets#7');
  assert.equal(r.signals.competing_prs, 0);
});

test('dead: closed, archived, rewarded label, paid comment', () => {
  assert.equal(evaluate({ issue: issue({ state: 'closed' }), repo }).verdict, 'dead');
  assert.equal(evaluate({ issue: issue(), repo: { ...repo, archived: true } }).verdict, 'dead');
  const rewarded = evaluate({ issue: issue({ labels: [{ name: 'bounty' }, { name: 'Rewarded' }] }), repo });
  assert.equal(rewarded.verdict, 'dead');
  assert.equal(rewarded.signals.rewarded_marker, true);
  const paid = evaluate({
    issue: issue(),
    repo,
    comments: [{ body: 'The bounty has been paid. Thanks!', user: { login: 'algora[bot]', type: 'Bot' } }],
  });
  assert.equal(paid.verdict, 'dead');
  // a random user saying "awarded" must not kill the issue
  const rando = evaluate({ issue: issue(), repo, comments: [comment('someone', 'Was this awarded yet?')] });
  assert.equal(rando.verdict, 'claimable');
});

test('not_real_money', () => {
  const dev = evaluate({ issue: issue({ body: 'Paid in devnet USDC' }), repo });
  assert.equal(dev.verdict, 'not_real_money');
  assert.equal(dev.signals.test_money, true);
  const fromComment = evaluate({ issue: issue(), repo, comments: [comment('maint', 'this is test USDC only')] });
  assert.equal(fromComment.verdict, 'not_real_money');
  const points = evaluate({
    issue: issue({ title: 'Add feature', labels: [{ name: 'points: 300' }], body: '' }),
    repo,
  });
  assert.equal(points.verdict, 'not_real_money');
});

test('restricted', () => {
  const assigned = evaluate({ issue: issue({ assignees: [{ login: 'bob' }] }), repo });
  assert.equal(assigned.verdict, 'restricted');
  assert.deepEqual(assigned.signals.assignees, ['bob']);
  assert.equal(evaluate({ issue: issue({ labels: [{ name: 'bounty: assigned' }] }), repo }).verdict, 'restricted');
  const bot = evaluate({
    issue: issue(),
    repo,
    comments: [{ body: 'Only maintainers can use /start to assign this issue.', user: { login: 'helper[bot]', type: 'Bot' } }],
  });
  assert.equal(bot.verdict, 'restricted');
  assert.equal(bot.signals.start_restricted, true);
});

test('contested', () => {
  assert.equal(evaluate({ issue: issue(), repo, crossReferencedPrCount: 2 }).verdict, 'contested');
  const claims = evaluate({
    issue: issue(),
    repo,
    comments: [comment('a', '/attempt'), comment('b', 'I am working on this'), comment('a', 'more')],
  });
  assert.equal(claims.verdict, 'contested');
  assert.equal(claims.signals.distinct_commenters, 2);
  const addr = evaluate({
    issue: issue(),
    repo,
    comments: [comment('a', 'payout 0x3D612420D3F72e41A5900A2C9768C1f46f5c4B4A'), comment('b', 'my wallet address is 0xabc')],
  });
  assert.equal(addr.verdict, 'contested');
  assert.equal(addr.signals.payout_address_comments, 2);
  const many = Array.from({ length: 15 }, (_, i) => comment('u1', `note ${i}`));
  assert.equal(evaluate({ issue: issue(), repo, comments: many }).verdict, 'contested');
});

test('precedence: dead beats everything, claimable needs amount or label', () => {
  const r = evaluate({ issue: issue({ state: 'closed', assignees: [{ login: 'x' }] }), repo, crossReferencedPrCount: 5 });
  assert.equal(r.verdict, 'dead');
  const none = evaluate({ issue: issue({ title: 'Plain issue', labels: [], body: '' }), repo });
  assert.equal(none.verdict, 'unclear');
  assert.equal(none.amount_usd, null);
});

test('sort and stats', () => {
  const recs = [
    { verdict: 'dead', amount_usd: 900 },
    { verdict: 'claimable', amount_usd: 50 },
    { verdict: 'claimable', amount_usd: 200 },
    { verdict: 'contested', amount_usd: 1000 },
  ];
  const sorted = sortRecords(recs);
  assert.deepEqual(sorted.map((r) => r.amount_usd), [200, 50, 1000, 900]);
  const s = computeStats(recs);
  assert.equal(s.total_advertised_usd, 2150);
  assert.equal(s.total_claimable_usd, 250);
  assert.equal(s.by_verdict.claimable, 2);
});

test('issue ref parsing', () => {
  assert.deepEqual(parseIssueRef({ issue: 'tenstorrent/tt-metal#58986' }).number, 58986);
  assert.equal(parseIssueRef({ url: 'https://github.com/owner/repo/issues/123' }).key, 'owner/repo#123');
  assert.equal(parseIssueRef({ issue: 'nonsense' }), null);
  assert.equal(parseIssueRef({ url: 'https://evil.example/owner/repo/issues/1' }), null);
  assert.equal(parseIssueRef({ issue: 'a/b#0' }), null);
  assert.equal(parseIssueRef({}), null);
});
