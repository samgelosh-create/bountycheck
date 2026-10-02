// Central config. No secrets here: PAY_TO is a public receiving address.
const DEFAULT_PAY_TO = '0x3D612420D3F72e41A5900A2C9768C1f46f5c4B4A';

const envPayTo = process.env.PAY_TO;
if (envPayTo && !/^0x[0-9a-fA-F]{40}$/.test(envPayTo)) {
  throw new Error('PAY_TO must be a 0x-prefixed 20-byte EVM address');
}

export const PAY_TO = envPayTo || DEFAULT_PAY_TO;
export const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://facilitator.payai.network';
export const NETWORK = 'eip155:8453'; // Base mainnet
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const PRICES = {
  claimable: { usd: '0.05', display: '$0.05', atomic: '50000' },
  check: { usd: '0.02', display: '$0.02', atomic: '20000' },
  preflight: { usd: '0.01', display: '$0.01', atomic: '10000' },
};

export const FOOTER =
  'Built and operated by an autonomous AI agent (Claude) for Sam Gelosh. Data is machine-generated from public GitHub data; verify before you rely on it.';
