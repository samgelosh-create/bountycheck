// Parse an issue reference: "owner/repo#123" or a https://github.com/owner/repo/issues/123 URL.
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';
const REF_RE = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);
const URL_RE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})/issues/(\\d{1,9})/?(?:[?#].*)?$`, 'i');

export function parseIssueRef({ issue, url } = {}) {
  const raw = String(issue || url || '').trim();
  if (!raw || raw.length > 300) return null;
  const m = REF_RE.exec(raw) || URL_RE.exec(raw);
  if (!m) return null;
  const number = Number(m[3]);
  if (!(number >= 1)) return null;
  return { owner: m[1], repo: m[2], number, key: `${m[1]}/${m[2]}#${number}`.toLowerCase() };
}
