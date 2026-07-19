import {
  privy,
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../lib/privy.js';

console.log('[bitcoin] module loaded');

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    code: error?.code ?? null,
    stack: error?.stack ?? null,
    cause: error?.cause ?? null,
    response: error?.response ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[bitcoin] ${step}`, JSON.stringify(extra));
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

async function createSegwitWallet(userId) {
  logStep('createSegwitWallet:start', { userId });

  const walletApi = privy?.walletApi;
  logStep('createSegwitWallet:wallet_api_check', {
    hasWalletApi: !!walletApi,
    createWalletType: typeof walletApi?.createWallet
  });

  if (!walletApi || typeof walletApi.createWallet !== 'function') {
    const error = new Error('privy.walletApi.createWallet is not available');
    error.status = 500;
    throw error;
  }

  const payload = {
    chain_type: 'bitcoin-segwit',
    owner: {
      user_id: userId
    }
  };

  logStep('createSegwitWallet:calling_createWallet', payload);

  const wallet = await walletApi.createWallet(payload);

  logStep('createSegwitWallet:success', {
    walletId: wallet?.id ?? null,
    address: wallet?.address ?? null,
    chainType: wallet?.chain_type ?? null
  });

  return wallet;
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

    const wallet = await createSegwitWallet(userId);

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
      details: serialized
    });
  }
}
