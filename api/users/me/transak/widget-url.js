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

// IMPORTANT: Transak allows only ONE valid access-token at a time — minting
// a new one immediately invalidates whatever token was issued before it
// (even if unexpired). An in-memory `let cachedAccessToken` therefore does
// NOT work correctly on Vercel: each serverless instance has its own copy,
// so two requests landing on different instances can each mint their own
// token, and the second call silently invalidates the first instance's
// token underneath it — producing exactly "Invalid or missing access-token"
// on whatever request uses the now-stale one.
//
// Fix: store the token in something ALL instances share — Vercel KV here.
// `vercel kv` is a managed Redis; add it from the Vercel dashboard
// (Storage tab) and it wires up KV_REST_API_URL / KV_REST_API_TOKEN env
// vars automatically. Swap for any other shared store (Upstash Redis, a
// Postgres row, etc.) if you already have one.
import { kv } from '@vercel/kv';

const ACCESS_TOKEN_KEY = `transak:${TRANSAK_ENV}:partner-access-token`;

async function getPartnerAccessToken() {
  const apiKey = requireEnv('TRANSAK_API_KEY');
  const apiSecret = requireEnv('TRANSAK_API_SECRET');

  const now = Math.floor(Date.now() / 1000);
  const cached = await kv.get(ACCESS_TOKEN_KEY); // { token, expiresAt } | null

  if (cached && cached.expiresAt - 60 > now) {
    return cached.token;
  }

  // NOTE: a small race is still possible if two instances both see a
  // stale/missing token at the same instant and both refresh — Transak's
  // "only one active token" rule means the loser's token then looks
  // "invalid" on its very next use. That's now rare (one 7-day refresh
  // instead of one per cold start) rather than routine. If you need it
  // fully race-proof, wrap this in a KV-based lock (e.g. `kv.set` with
  // `NX` as a mutex) before calling refresh-token.
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
  const record = { token: data.accessToken, expiresAt: data.expiresAt };
  await kv.set(ACCESS_TOKEN_KEY, record);
  return record.token;
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
