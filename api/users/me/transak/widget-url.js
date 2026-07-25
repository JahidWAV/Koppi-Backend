// pages/api/users/me/transak/widget-url.js
//
// Next.js Pages Router API route. Key differences from the earlier
// Express-style reference:
//   - MUST be a default export — Next.js invokes `export default`, not a
//     named export. This alone is likely why you got
//     FUNCTION_INVOCATION_FAILED: with only `module.exports = { ... }`,
//     Next had no handler to actually call.
//   - req.body is already parsed JSON here (Pages Router does this for
//     you) — no need for anything extra as long as the client sends
//     Content-Type: application/json, which TransakWidgetService.swift does.
//   - The whole handler is wrapped in one top-level try/catch so ANY
//     unexpected error (missing env var, etc.) still comes back as JSON
//     with a real message instead of Vercel's generic crash page — that
//     alone will turn your next failed test into something you can act on.

const TRANSAK_ENV = process.env.TRANSAK_ENV === 'staging' ? 'staging' : 'production';

const TRANSAK_API_BASE = TRANSAK_ENV === 'staging'
  ? 'https://api-gateway-stg.transak.com'
  : 'https://api-gateway.transak.com';

const TRANSAK_AUTH_BASE = TRANSAK_ENV === 'staging'
  ? 'https://api-stg.transak.com'
  : 'https://api.transak.com';

const CHAIN_TO_TRANSAK_ASSET = {
  evm: { network: 'base', cryptoCurrencyCode: 'ETH' },
  solana: { network: 'solana', cryptoCurrencyCode: 'SOL' },
  bitcoin: { network: undefined, cryptoCurrencyCode: 'BTC' },
};

// NOTE on the in-memory cache below: Transak allows only ONE valid
// access-token at a time — minting a new one invalidates whatever was
// issued before it. This `let` only lives in a single serverless
// instance's memory, so it's fine for manual/staging testing (one warm
// instance), but NOT safe once multiple instances handle traffic
// concurrently in production — two instances could each mint their own
// token and invalidate each other. Before going live, move this to a
// store all instances share (Vercel KV, Upstash Redis, a DB row, etc.).
let cachedAccessToken = null; // { token, expiresAt }

async function getPartnerAccessToken() {
  const apiKey = requireEnv('TRANSAK_API_KEY');
  const apiSecret = requireEnv('TRANSAK_API_SECRET');

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60 > now) {
    return cachedAccessToken.token;
  }

  const res = await fetch(`${TRANSAK_AUTH_BASE}/partners/api/v2/refresh-token`, {
    method: 'POST',
    headers: {
      'api-secret': apiSecret,
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ apiKey }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Transak refresh-token failed (${res.status}): ${bodyText}`);
  }

  const { data } = JSON.parse(bodyText);
  cachedAccessToken = { token: data.accessToken, expiresAt: data.expiresAt };
  return cachedAccessToken.token;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    // This is almost certainly your actual crash if env vars aren't set
    // in the Vercel project settings for this environment (Production /
    // Preview / Development each have their own!).
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    // TODO: replace with your real Privy-token verification (same
    // middleware/logic used by your balances/activity routes). Left
    // explicit here rather than assumed, since a throw inside auth
    // verification with no try/catch was one of the two likely causes of
    // the crash you hit.
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing bearer token.' });
    }
    // const privyUser = await verifyPrivyToken(authHeader.slice(7));

    const { chain, walletAddress } = req.body || {};
    const asset = CHAIN_TO_TRANSAK_ASSET[chain];

    if (!asset || !walletAddress) {
      return res.status(400).json({ error: 'Missing or invalid chain/walletAddress.' });
    }

    const accessToken = await getPartnerAccessToken();
    const apiKey = requireEnv('TRANSAK_API_KEY');

    const forwardedFor = req.headers['x-forwarded-for'];
    const userIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || '')
      .split(',')[0]
      .trim() || req.socket?.remoteAddress || '';

    const widgetParams = {
      apiKey,
      referrerDomain: 'api.koppi.app',
      productsAvailed: 'BUY',
      walletAddress,
      disableWalletAddressForm: true,
      cryptoCurrencyCode: asset.cryptoCurrencyCode,
      themeColor: '000000',
      colorMode: 'LIGHT',
      redirectURL: 'https://api.koppi.app/transak-return',
    };
    if (asset.network) {
      widgetParams.network = asset.network;
    }

    const sessionRes = await fetch(`${TRANSAK_API_BASE}/api/v2/auth/session`, {
      method: 'POST',
      headers: {
        'access-token': accessToken,
        'x-api-key': apiKey,
        'x-user-ip': userIp,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ widgetParams }),
    });

    const sessionBodyText = await sessionRes.text();
    if (!sessionRes.ok) {
      console.error('Transak create-widget-url failed:', sessionRes.status, sessionBodyText);
      return res.status(502).json({ error: `Transak session creation failed (${sessionRes.status}).` });
    }

    const { data } = JSON.parse(sessionBodyText);
    return res.status(200).json({ widgetUrl: data.widgetUrl });
  } catch (error) {
    // This is the important part: no matter what breaks above, the
    // response is always JSON, never Vercel's generic crash page.
    console.error('transak/widget-url crashed:', error);
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
