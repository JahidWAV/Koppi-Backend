import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../lib/privy.js';
import { env } from '../../../../lib/env.js';

console.log('[bitcoin] module loaded');

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    code: error?.code ?? null,
    stack: error?.stack ?? null,
    cause: error?.cause ?? null,
    response: error?.response ?? null,
    body: error?.body ?? null,
    data: error?.data ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[bitcoin] ${step}`, JSON.stringify(extra));
}

function getPrivyBasicAuthHeader() {
  const credentials = Buffer.from(`${env.appId}:${env.appSecret}`).toString('base64');
  return `Basic ${credentials}`;
}

async function verifyAccessToken(req) {
  logStep('verifyAccessToken:start');

  const token = getBearerToken(req);

  if (!token) {
    logStep('verifyAccessToken:missing_token');
    const error = new Error('Missing bearer token');
    error.status = 401;
    throw error;
  }

  logStep('verifyAccessToken:token_found', {
    tokenLength: token.length
  });

  const claims = await verifyPrivyAccessToken(token);

  logStep('verifyAccessToken:success', {
    userId: claims?.userId ?? null,
    appId: claims?.appId ?? null,
    issuer: claims?.issuer ?? null
  });

  return {
    token,
    userId: claims?.userId ?? null,
    claims
  };
}

async function listBitcoinWalletsForUser(userId) {
  const url = new URL('https://api.privy.io/v1/wallets');
  url.searchParams.set('user_id', userId);
  url.searchParams.set('chain_type', 'bitcoin-segwit');
  url.searchParams.set('limit', '100');

  logStep('listBitcoinWalletsForUser:calling_rest_api', {
    url: url.toString(),
    userId
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'privy-app-id': env.appId
    }
  });

  const responseText = await response.text();

  logStep('listBitcoinWalletsForUser:rest_response', {
    status: response.status,
    ok: response.ok,
    body: responseText
  });

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Privy wallet lookup failed with status ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  return Array.isArray(parsed?.data) ? parsed.data : [];
}

async function createSegwitWallet(userId) {
  logStep('createSegwitWallet:start', { userId });

  // No `owner` set: this wallet is app-controlled (same model as the
  // EVM/Solana wallets), so the backend can sign for it directly via
  // raw_sign with just Basic Auth -- no authorization-signature dance.
  // (An earlier version of this set `owner: { user_id: userId }`, making
  // the wallet self-custodial; that requires signing from the *user's*
  // device via the Privy client SDK, which this backend-only flow can't
  // do, and left at least one wallet permanently unusable from here.)
  const payload = {
    chain_type: 'bitcoin-segwit'
  };

  logStep('createSegwitWallet:calling_rest_api', payload);

  const response = await fetch('https://api.privy.io/v1/wallets', {
    method: 'POST',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'Content-Type': 'application/json',
      'privy-app-id': env.appId
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  logStep('createSegwitWallet:rest_response', {
    status: response.status,
    ok: response.ok,
    body: responseText
  });

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Privy REST wallet creation failed with status ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  return parsed;
}

/// Picks a wallet the backend can actually sign for. Prefers wallets with
/// no `owner_id` (app-controlled, backend can raw_sign directly); among
/// those, picks the most recently created one. This intentionally skips
/// over any user-owned or orphaned-owner wallets left over from before
/// this app switched Bitcoin wallets to the app-controlled model.
function pickUsableWallet(wallets) {
  const usable = wallets.filter((w) => !w.owner_id);
  if (usable.length === 0) return null;
  usable.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
  return usable[0];
}

async function fetchOrCreateSegwitWallet(userId) {
  const existingWallets = await listBitcoinWalletsForUser(userId);

  const usableWallet = pickUsableWallet(existingWallets);

  if (usableWallet) {
    logStep('fetchOrCreateSegwitWallet:found_existing_wallet', {
      walletId: usableWallet?.id ?? null,
      address: usableWallet?.address ?? null,
      chainType: usableWallet?.chain_type ?? null
    });

    return usableWallet;
  }

  const orphanedCount = existingWallets.filter((w) => w.owner_id).length;
  if (orphanedCount > 0) {
    logStep('fetchOrCreateSegwitWallet:ignoring_orphaned_wallets', {
      orphanedCount,
      orphanedIds: existingWallets.filter((w) => w.owner_id).map((w) => w.id)
    });
  }

  logStep('fetchOrCreateSegwitWallet:no_usable_wallet_creating_new');

  return await createSegwitWallet(userId);
}

export default async function handler(req, res) {
  logStep('handler:start', {
    method: req.method,
    url: req.url,
    hasAuthorizationHeader: !!(req.headers.authorization || req.headers.Authorization),
    contentType: req.headers['content-type'] ?? null,
    userAgent: req.headers['user-agent'] ?? null
  });

  if (req.method !== 'POST') {
    logStep('handler:method_not_allowed', { method: req.method });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    logStep('handler:before_verify_token');

    const { userId, claims } = await verifyAccessToken(req);

    logStep('handler:after_verify_token', {
      userId,
      claimsKeys: claims ? Object.keys(claims) : []
    });

    const wallet = await fetchOrCreateSegwitWallet(userId);

    logStep('handler:success_response', {
      walletId: wallet?.id ?? null,
      address: wallet?.address ?? null
    });

    return res.status(200).json({
      ok: true,
      userId,
      walletId: wallet?.id ?? null,
      address: wallet?.address ?? null,
      publicKey: wallet?.public_key ?? null,
      chainType: wallet?.chain_type ?? null,
      wallet
    });
  } catch (error) {
    const serialized = safeSerializeError(error);

    console.error('[bitcoin] handler:error', JSON.stringify(serialized));

    return res.status(error?.status || 500).json({
      error: 'Wallet creation failed',
      message: error?.message ?? null,
      name: error?.name ?? null,
      code: error?.code ?? null,
      cause: error?.cause ?? null,
      response: error?.response ?? null,
      details: serialized
    });
  }
}
