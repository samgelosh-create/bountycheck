// Pure verdict logic. No I/O. Input shapes follow the GitHub REST API.

export const VERDICTS = ['claimable', 'contested', 'restricted', 'not_real_money', 'dead', 'unclear'];

const AMOUNT_MIN = 1;
const AMOUNT_MAX = 100000;

function toNumber(raw, kilo) {
  let n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (kilo) n *= 1000;
  return n;
}

function plausible(n) {
  return n !== null && n >= AMOUNT_MIN && n <= AMOUNT_MAX;
}

/** Return the first plausible USD-ish amount found in `text`, or null. */
export function parseAmountFromText(text) {
  if (!text) return null;
  const s = String(text);
  const candidates = [];
  // $1,000  $75  $2k  $1.5k  (position-tagged so the earliest match wins)
  for (const m of s.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kK])?(?![A-Za-z0-9])/g)) {
    candidates.push({ at: m.index, n: toNumber(m[1], !!m[2]) });
  }
  // 150 USDC   Price: 75 USD   2k USDT
  for (const m of s.matchAll(/(?<![\w.$])(\d[\d,]*(?:\.\d+)?)\s?([kK])?\s?(?:USDC|USDT|USD|DAI)\b/gi)) {
    candidates.push({ at: m.index, n: toNumber(m[1], !!m[2]) });
  }
  candidates.sort((a, b) => a.at - b.at);
  for (const c of candidates) if (plausible(c.n)) return c.n;
  return null;
}

export function labelNames(issue) {
  return (issue?.labels || [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);
}

/** title, then labels, then body. */
export function parseAmount(issue) {
  const fromTitle = parseAmountFromText(issue?.title);
  if (fromTitle !== null) return fromTitle;
  for (const l of labelNames(issue)) {
    const v = parseAmountFromText(l);
    if (v !== null) return v;
  }
  return parseAmountFromText(issue?.body);
}

const isBot = (c) => c?.user?.type === 'Bot' || /\[bot\]$/i.test(c?.user?.login || '');

const REWARD_RE = /awarded|has been paid|💰|bounty (was )?paid/i;
const TEST_MONEY_RE =
  /\b(devnet|testnet|test\s+usdc|test\s+tokens?|test\s+money|fake\s+(money|usdc|tokens?)|play\s+money|sepolia|faucet)\b/i;
const START_LIMIT_RE =
  /(collaborators?|maintainers?|members?|contributors?)\b[^.\n]{0,60}\b(only|can|may|allowed)\b|\b(only|limited to|restricted to|reserved for)\b[^.\n]{0,60}\b(collaborators?|maintainers?|members?)\b|not (allowed|permitted) to (start|assign)/i;
const CLAIM_RE =
  /\/attempt|\/claim|\/start|\/bounty|\bi(?:'m| am| will|'ll)? (?:working|take|taking|claim|on it|start|pick)|\bi(?:'d| would) (?:like|love) to (?:work|take|try|tackle)|\bcan i (?:work|take|try|pick|have)|\bworking on (?:this|it)\b|\battempt(?:ing)?\b|\bclaim(?:ing|ed)?\b|\bpull request\b|\bsubmitted\b/i;
// Anyone (not only a bot) reporting that assignment is gated; weaker evidence, flagged as unconfirmed.
const REPORTED_LIMIT_RE =
  /restrict\w*[^.\n]{0,80}\b(collaborators?|maintainers?|members?)\b|\b(collaborators?|maintainers?)[- ]only\b/i;
const RESERVED_TITLE_RE = /\bRESERVED\b/;
const PROPOSED_TITLE_RE = /proposed reward|bounty proposal|\bproposal\b/i;
const MIRROR_TITLE_RE = /^\s*\[bounty\]\s*\[bounty|^\s*\[radar\]/i;
const MIRROR_REPO_RE = /bounty-plaza|bounty-board|bounty-radar|monetization-runtime/i;
const EVM_ADDR_RE = /\b0x[0-9a-fA-F]{40}\b/;
const WALLET_RE = /\b(wallet|payout|payment|usdc|solana|sol)\s+(address|addr)\b/i;

function hasBountyLabel(labels) {
  return labels.some((l) => /bounty|bounties|💎|💰/i.test(l));
}

function repoFullName(issue, repo) {
  if (repo?.full_name) return repo.full_name;
  const m = /repos\/([^/]+\/[^/]+)$/.exec(issue?.repository_url || '');
  return m ? m[1] : 'unknown/unknown';
}

/**
 * evaluate({issue, repo, comments, crossReferencedPrCount}) -> record
 * Verdicts, first match wins: dead, not_real_money, unclear (mirror / proposed-only), restricted,
 * contested, claimable (needs a parsed amount), else unclear. "claimable" means it passed these
 * automated checks; it is not a guarantee of payment.
 */
export function evaluate({ issue, repo, comments = [], crossReferencedPrCount = 0 }) {
  issue = issue || {};
  repo = repo || {};
  comments = Array.isArray(comments) ? comments : [];

  const labels = labelNames(issue);
  const fullName = repoFullName(issue, repo);
  const amount = parseAmount(issue);
  const ownerLogin = (repo.owner?.login || fullName.split('/')[0] || '').toLowerCase();

  const assignees = (issue.assignees && issue.assignees.length ? issue.assignees : issue.assignee ? [issue.assignee] : [])
    .map((a) => a?.login)
    .filter(Boolean);

  const commenters = new Set();
  const claimers = new Set();
  let payoutAddressComments = 0;
  let rewardedByComment = false;
  let startRestricted = false;
  let reportedRestricted = false;
  let testMoney = TEST_MONEY_RE.test(`${issue.title || ''}\n${issue.body || ''}`);

  for (const c of comments) {
    const body = c?.body || '';
    const login = c?.user?.login;
    const bot = isBot(c);
    if (!bot && login) commenters.add(login);
    if (TEST_MONEY_RE.test(body)) testMoney = true;
    const ownerish = bot || (login || '').toLowerCase() === ownerLogin || c?.author_association === 'OWNER';
    if (ownerish && REWARD_RE.test(body)) rewardedByComment = true;
    if (bot && /\/start|assign/i.test(body) && START_LIMIT_RE.test(body)) startRestricted = true;
    if (!bot && REPORTED_LIMIT_RE.test(body)) reportedRestricted = true;
    if (!bot && login) {
      const hasAddr = EVM_ADDR_RE.test(body) || WALLET_RE.test(body);
      if (hasAddr) payoutAddressComments += 1;
      if (hasAddr || CLAIM_RE.test(body)) claimers.add(login);
    }
  }

  const rewardedLabel = labels.some((l) => /rewarded/i.test(l));
  const rewardedMarker = rewardedLabel || rewardedByComment;
  const pointsLabelNoMoney = amount === null && labels.some((l) => /^\s*points?\s*:/i.test(l));
  if (pointsLabelNoMoney) testMoney = true;
  const assignedLabel = labels.some((l) => /bounty:\s*assigned/i.test(l));
  const competingPrs = Number.isFinite(crossReferencedPrCount) ? crossReferencedPrCount : 0;
  const commentCount = comments.length > (issue.comments || 0) ? comments.length : issue.comments || 0;

  const title = issue.title || '';
  const reservedTitle = RESERVED_TITLE_RE.test(title);
  const proposedOnly = PROPOSED_TITLE_RE.test(title);
  const mirror = MIRROR_TITLE_RE.test(title) || MIRROR_REPO_RE.test(fullName);

  const reasons = [];
  let verdict;
  if (issue.state === 'closed' || repo.archived === true || rewardedMarker) {
    verdict = 'dead';
    if (issue.state === 'closed') reasons.push('issue is closed');
    if (repo.archived === true) reasons.push('repository is archived');
    if (rewardedLabel) reasons.push('has a "Rewarded" label');
    if (rewardedByComment) reasons.push('bot/owner comment indicates the reward was already paid');
  } else if (testMoney) {
    verdict = 'not_real_money';
    reasons.push(pointsLabelNoMoney ? 'points label with no dollar amount' : 'mentions devnet/testnet/test tokens');
  } else if (mirror) {
    verdict = 'unclear';
    reasons.push('aggregator or mirror issue, not the original bounty');
  } else if (proposedOnly) {
    verdict = 'unclear';
    reasons.push('reward is only proposed, not confirmed as funded');
  } else if (assignees.length > 0 || assignedLabel || startRestricted || reportedRestricted || reservedTitle) {
    verdict = 'restricted';
    if (reservedTitle) reasons.push('title says the bounty is reserved');
    if (reportedRestricted && !startRestricted)
      reasons.push('a commenter reports assignment is limited to collaborators/maintainers (unconfirmed)');
    if (assignees.length) reasons.push(`assigned to ${assignees.join(', ')}`);
    if (assignedLabel) reasons.push('label says bounty is assigned');
    if (startRestricted) reasons.push('bot comment says assignment/start is limited to collaborators/maintainers');
  } else if (competingPrs >= 2 || claimers.size >= 2 || commentCount >= 15) {
    verdict = 'contested';
    if (competingPrs >= 2) reasons.push(`${competingPrs} cross-referenced pull requests`);
    if (claimers.size >= 2) reasons.push(`${claimers.size} distinct commenters posted claims/attempts/payout addresses`);
    if (commentCount >= 15) reasons.push(`${commentCount} comments`);
  } else if (amount !== null) {
    verdict = 'claimable';
    reasons.push(`open, unassigned, amount parsed ($${amount}); passed automated checks only`);
    if ((repo.stargazers_count ?? 0) < 5) reasons.push('payer unproven: repository has fewer than 5 stars');
  } else {
    verdict = 'unclear';
    reasons.push(hasBountyLabel(labels) ? 'bounty label but no dollar amount found' : 'no dollar amount parsed and no bounty label');
  }

  return {
    issue: `${fullName}#${issue.number}`,
    url: issue.html_url || `https://github.com/${fullName}/issues/${issue.number}`,
    title: issue.title || '',
    created_at: issue.created_at || null,
    amount_usd: amount,
    verdict,
    reasons,
    signals: {
      state: issue.state || null,
      repo_archived: repo.archived === true,
      repo_stars: repo.stargazers_count ?? null,
      repo_created_at: repo.created_at || null,
      assignees,
      comment_count: commentCount,
      distinct_commenters: commenters.size,
      competing_prs: competingPrs,
      rewarded_marker: rewardedMarker,
      start_restricted: startRestricted || reportedRestricted || reservedTitle,
      test_money: testMoney,
      payout_address_comments: payoutAddressComments,
    },
  };
}

/** claimable first, then the other verdicts in VERDICTS order, then amount desc. */
export function sortRecords(records) {
  const rank = (v) => {
    const i = VERDICTS.indexOf(v);
    return i === -1 ? VERDICTS.length : i;
  };
  return [...records].sort(
    (a, b) => rank(a.verdict) - rank(b.verdict) || (b.amount_usd ?? -1) - (a.amount_usd ?? -1),
  );
}

export function computeStats(records) {
  const by_verdict = {};
  for (const v of VERDICTS) by_verdict[v] = 0;
  let advertised = 0;
  let claimableUsd = 0;
  for (const r of records) {
    by_verdict[r.verdict] = (by_verdict[r.verdict] || 0) + 1;
    advertised += r.amount_usd || 0;
    if (r.verdict === 'claimable') claimableUsd += r.amount_usd || 0;
  }
  return {
    record_count: records.length,
    by_verdict,
    total_advertised_usd: advertised,
    total_claimable_usd: claimableUsd,
  };
}
