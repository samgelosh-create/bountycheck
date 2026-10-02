// Live, unauthenticated GitHub REST fetch used by /v1/check when an issue is not in the bundled dataset.
import { evaluate } from './verdict.mjs';

export class GithubError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'not_found' | 'bad_input' | 'upstream'
  }
}

async function ghGet(path, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bountycheck/0.1 (+x402)' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new GithubError('upstream', 'GitHub unreachable');
  }
  if (res.status === 404 || res.status === 410) throw new GithubError('not_found', 'issue or repository not found');
  if (res.status === 403 || res.status === 429) throw new GithubError('upstream', 'GitHub rate limit reached');
  if (!res.ok) throw new GithubError('upstream', `GitHub returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new GithubError('upstream', 'GitHub returned invalid JSON');
  }
}

/** Live check. competing_prs is not fetched live (timeline needs auth-free but extra calls); reported as 0. */
export async function liveCheck({ owner, repo, number }, fetchImpl = fetch) {
  const issue = await ghGet(`/repos/${owner}/${repo}/issues/${number}`, fetchImpl);
  if (issue.pull_request) throw new GithubError('bad_input', 'reference is a pull request, not an issue');
  const repoData = await ghGet(`/repos/${owner}/${repo}`, fetchImpl);
  const comments = await ghGet(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`, fetchImpl);
  return evaluate({ issue, repo: repoData, comments, crossReferencedPrCount: 0 });
}
