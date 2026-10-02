import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../lib/verdict.mjs';

const repo = (over = {}) => ({ full_name: 'acme/widgets', archived: false, stargazers_count: 120, owner: { login: 'acme' }, ...over });
const issue = (over = {}) => ({ number: 7, state: 'open', title: 'Fix the parser [$100]', body: '', labels: [], assignees: [], comments: 0, ...over });
const human = (login, body) => ({ user: { login, type: 'User' }, body });

test('mirror or aggregator issues are unclear, not claimable', () => {
  const a = evaluate({ issue: issue({ title: '[Bounty] [Bounty $1,000] FP32 cumsum returns NaN' }), repo: repo({ full_name: 'someone/bounty-plaza' }) });
  assert.equal(a.verdict, 'unclear');
  const b = evaluate({ issue: issue({ title: '[radar] SN open bounty 2026-10-02', labels: [{ name: 'bounty' }] }), repo: repo() });
  assert.equal(b.verdict, 'unclear');
});

test('proposed-only rewards are unclear', () => {
  const r = evaluate({ issue: issue({ title: '[GOOD FIRST ISSUE · PROPOSED REWARD] Add tests — 25 USD' }), repo: repo() });
  assert.equal(r.verdict, 'unclear');
  assert.match(r.reasons.join(' '), /proposed/);
});

test('reserved title and commenter-reported collaborator limits are restricted', () => {
  const a = evaluate({ issue: issue({ title: '[PAID BOUNTY · RESERVED] Onboarding — 25 USD' }), repo: repo() });
  assert.equal(a.verdict, 'restricted');
  const b = evaluate({
    issue: issue({ title: 'Probe only recognizes localhost', labels: [{ name: 'Price: 75 USD' }] }),
    repo: repo(),
    comments: [human('someone', 'The current organization config restricts `/start` on Priority 2 issues to collaborators.')],
  });
  assert.equal(b.verdict, 'restricted');
  assert.match(b.reasons.join(' '), /unconfirmed/);
});

test('bounty label without an amount is unclear; low-star payer is flagged', () => {
  const a = evaluate({ issue: issue({ title: 'Do a thing', labels: [{ name: 'bounty' }] }), repo: repo() });
  assert.equal(a.verdict, 'unclear');
  const b = evaluate({ issue: issue(), repo: repo({ stargazers_count: 0 }) });
  assert.equal(b.verdict, 'claimable');
  assert.match(b.reasons.join(' '), /unproven/);
});
