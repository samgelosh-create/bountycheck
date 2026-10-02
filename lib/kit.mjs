// The starter guide is a paid product; the public repo ships this stub. Live teaser: https://bountycheck.vercel.app/kit
const page = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x402 starter guide</title></head><body><h1>Ship a pay-per-call x402 API: starter guide</h1>${body}</body></html>`;

export function kitTeaserHtml() {
  return page('<p>See <a href="https://bountycheck.vercel.app/kit">bountycheck.vercel.app/kit</a>.</p>');
}

export function kitHtml() {
  return page('<p>Not included in the public repository.</p>');
}
