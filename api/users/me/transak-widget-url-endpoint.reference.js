/**
 * Reference implementation for POST /api/users/me/transak/widget-url
 *
 * This is the backend counterpart to iOS's `TransakWidgetService`. It's
 * written as plain Node/Express so the logic is easy to port to whatever
 * framework api.koppi.app actually runs (Fastify, Next.js API routes,
 * Django, Rails, etc.) — the important part is the two outbound calls to
 * Transak and the constraints called out inline, not the framework.
 *
 * Why this has to live on the backend at all: Transak deprecated building
 * the widget URL client-side. The new flow requires a Partner Access Token
 * that must stay server-side, and Transak's Create Widget URL API flatly
 * rejects calls that don't come from a whitelisted partner backend IP:
 *   https://docs.transak.com/guides/migration-to-api-based-transak-widget-url
 *   https://docs.transak.com/api/public/create-widget-url
 */

const TRANSAK_API_BASE = process.env.TRANSAK_ENV === 'staging'
  ? 'https://api-gateway-stg.transak.com'
  : 'https://api-gateway.transak.com';

const TRANSAK_AUTH_BASE = process.env.TRANSAK_ENV === 'staging'
  ? 'https://api-stg.transak.com'
  : 'https://api.transak.com';

const TRANSAK_API_KEY = process.env.TRANSAK_API_KEY;       // Partner API key (dashboard)
const TRANSAK_API_SECRET = process.env.TRANSAK_API_SECRET; // Partner API secret (dashboard) — NEVER ship this in the app

// Maps this app's chain identifiers to Transak's network / cryptoCurrencyCode.
// (Mirrors the mapping that used to live in Transakbuyview.swift.)
const CHAIN_TO_TRANSAK_ASSET = {
  evm: { network: 'base', cryptoCurrencyCode: 'ETH' },
  solana: { network: 'solana', cryptoCurrencyCode: 'SOL' },
  bitcoin: { network: undefined, cryptoCurrencyCode: 'BTC' },
};

/**
 * Partner Access Token cache. Transak's docs explicitly warn against
 * calling Refresh Access Token on every request — the token is valid for
 * 7 days, so cache it (in memory here; use Redis/similar for a
 * multi-instance deployment so instances share one token and don't each
 * mint their own).
 */
let cachedAccessToken = null; // { token, expiresAt } — expiresAt in epoch seconds

async function getPartnerAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60 > now) {
    return cachedAccessToken.token;
  }

  const res = await fetch(`${TRANSAK_AUTH_BASE}/partners/api/v2/refresh-token`, {
    method: 'POST',
    headers: {
      'api-secret': TRANSAK_API_SECRET,
      'x-api-key': TRANSAK_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ apiKey: TRANSAK_API_KEY }),
  });

  if (!res.ok) {
    throw new Error(`Transak refresh-token failed: ${res.status}`);
  }

  const { data } = await res.json();
  cachedAccessToken = { token: data.accessToken, expiresAt: data.expiresAt };
  return cachedAccessToken.token;
}

/**
 * POST /api/users/me/transak/widget-url
 * Auth: same Bearer(Privy access token) middleware as the balances/activity
 * routes — reuse it here too, don't skip auth just because this is a
 * "just get a URL" endpoint.
 *
 * Body: { chain: "evm" | "solana" | "bitcoin", walletAddress: string }
 * Response: { widgetUrl: string }
 */
async function createTransakWidgetUrlHandler(req, res) {
  const { chain, walletAddress } = req.body || {};
  const asset = CHAIN_TO_TRANSAK_ASSET[chain];

  if (!asset || !walletAddress) {
    return res.status(400).json({ error: 'Missing or invalid chain/walletAddress.' });
  }

  try {
    const accessToken = await getPartnerAccessToken();

    // Required per Transak's mandatory security changes — the end user's
    // real originating IP, not this server's IP. Adjust the extraction to
    // match your actual proxy setup (e.g. the first hop in X-Forwarded-For,
    // or req.ip if you've configured Express's `trust proxy` correctly).
    const userIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

    const widgetParams = {
      apiKey: TRANSAK_API_KEY,
      referrerDomain: 'api.koppi.app', // must match what's registered in the Transak dashboard
      productsAvailed: 'BUY',
      walletAddress,
      disableWalletAddressForm: true,
      cryptoCurrencyCode: asset.cryptoCurrencyCode,
      themeColor: '000000',
      colorMode: 'LIGHT',
      redirectURL: 'https://api.koppi.app/transak-return', // must match TransakConfig.redirectURL in the app
    };
    if (asset.network) {
      widgetParams.network = asset.network;
    }

    const sessionRes = await fetch(`${TRANSAK_API_BASE}/api/v2/auth/session`, {
      method: 'POST',
      headers: {
        'access-token': accessToken,
        'x-api-key': TRANSAK_API_KEY,
        'x-user-ip': userIp,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ widgetParams }),
    });

    if (!sessionRes.ok) {
      const errBody = await sessionRes.text();
      console.error('Transak create-widget-url failed:', sessionRes.status, errBody);
      return res.status(502).json({ error: 'Could not start the Transak session.' });
    }

    const { data } = await sessionRes.json();
    // NOTE: data.widgetUrl expires in 5 minutes and is single-use — return
    // it as-is and don't cache it server-side either.
    return res.status(200).json({ widgetUrl: data.widgetUrl });
  } catch (error) {
    console.error('createTransakWidgetUrlHandler error:', error);
    return res.status(500).json({ error: 'Unexpected error creating the Transak session.' });
  }
}

module.exports = { createTransakWidgetUrlHandler };
