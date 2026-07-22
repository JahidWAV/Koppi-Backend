const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function logStep(step, data = {}) {
  console.log(JSON.stringify({ step, ...data }));
}

function logError(step, error, data = {}) {
  console.error(
    JSON.stringify({
      step,
      ...data,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    })
  );
}

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim() || null;
}

function getPrivyBasicAuthHeader() {
  const raw = `${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

async function privyFetch(path) {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error('Missing PRIVY_APP_ID or PRIVY_APP_SECRET');
  }

  const response = await fetch(`https://api.privy.io${path}`, {
    method: 'GET',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'privy-app-id': PRIVY_APP_ID,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Privy API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function getCurrentPrivyUser(accessToken) {
  const response = await fetch('https://auth.privy.io/api/v1/users/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Privy auth error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const userId = data?.user?.id ?? data?.id ?? null;

  if (!userId) {
    throw new Error('Could not resolve current Privy user id');
  }

  return {
    raw: data,
    id: userId,
  };
}

async function getWalletsForUser(userId) {
  const params = new URLSearchParams({
    user_id: userId,
    limit: '100',
  });

  const response = await privyFetch(`/v1/wallets?${params.toString()}`);
  return response.data || [];
}

function pickWallet(wallets, chainType) {
  const matches = wallets.filter((wallet) => wallet.chain_type === chainType);
  if (matches.length === 0) return null;

  matches.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return matches[0];
}

async function getPrivyTransactions(walletId, chain) {
  const params = new URLSearchParams({
    chain,
    limit: '50',
  });

  const response = await privyFetch(
    `/v1/wallets/${walletId}/transactions?${params.toString()}`
  );

  return response.transactions || [];
}

function symbolForAsset(asset, chain) {
  const normalized = String(asset || '').toLowerCase();
  if (normalized === 'eth') return 'ETH';
  if (normalized === 'sol') return 'SOL';
  if (normalized === 'usdc') return 'USDC';
  if (normalized === 'usdt') return 'USDT';
  return chain === 'base' ? 'ETH' : 'SOL';
}

function safeDisplayNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatPrivyAmount(detail, chain) {
  const symbol = symbolForAsset(detail.asset, chain);
  const key = String(detail.asset || '').toLowerCase();
  const display =
    detail.display_values?.[key] ??
    detail.display_values?.amount ??
    detail.display_values?.display_amount ??
    null;
  const sign = detail.type === 'transfer_received' ? '+' : '-';

  if (display) {
    return `${sign}${display} ${symbol}`;
  }

  const raw = safeDisplayNumber(detail.raw_value || 0);
  const decimals = safeDisplayNumber(detail.raw_value_decimals || 0) ?? 0;

  if (raw === null) {
    return `${sign}0 ${symbol}`;
  }

  const value = decimals > 0 ? raw / Math.pow(10, decimals) : raw;
  return `${sign}${value} ${symbol}`;
}

function normalizePrivyTimestamp(value) {
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  if (typeof value === 'number') {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return new Date(0).toISOString();
}

function mapPrivyTransaction(tx, chain) {
  if (!tx) return null;

  const detail = tx.details;
  if (!detail) return null;

  if (detail.type !== 'transfer_sent' && detail.type !== 'transfer_received') {
    return null;
  }

  const direction = detail.type === 'transfer_received' ? 'incoming' : 'outgoing';
  const symbol = symbolForAsset(detail.asset, chain);
  const isIncoming = direction === 'incoming';

  return {
    id: tx.privy_transaction_id || tx.id || tx.transaction_hash || `${chain}-${tx.created_at}`,
    chain,
    title: isIncoming ? `Received ${symbol}` : `Sent ${symbol}`,
    subtitle: chain === 'base' ? 'Base' : 'Solana',
    amountText: formatPrivyAmount(detail, chain),
    fiatText: null,
    timestamp: normalizePrivyTimestamp(tx.created_at),
    txHash: tx.transaction_hash || null,
    status: tx.status || 'confirmed',
    direction,
  };
}

function satoshisToBTCString(value) {
  const btc = value / 100000000;
  return btc.toFixed(8).replace(/\.?0+$/, '');
}

function netValueForBitcoinAddress(tx, address) {
  const received = (tx.vout || [])
    .filter((out) => out.scriptpubkey_address === address)
    .reduce((sum, out) => sum + (out.value || 0), 0);

  const spent = (tx.vin || [])
    .filter((input) => input.prevout && input.prevout.scriptpubkey_address === address)
    .reduce((sum, input) => sum + ((input.prevout && input.prevout.value) || 0), 0);

  return received - spent;
}

async function getBitcoinActivity(bitcoinAddress) {
  if (!bitcoinAddress) return [];

  const response = await fetch(
    `https://blockstream.info/api/address/${encodeURIComponent(bitcoinAddress)}/txs`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Blockstream API error ${response.status}: ${text}`);
  }

  const txs = await response.json();

  return txs
    .map((tx) => {
      const net = netValueForBitcoinAddress(tx, bitcoinAddress);
      const direction = net > 0 ? 'incoming' : net < 0 ? 'outgoing' : 'neutral';
      const sign = net > 0 ? '+' : net < 0 ? '-' : '';
      const blockTime = tx?.status?.block_time || 0;
      const timestamp = new Date(blockTime * 1000).toISOString();

      return {
        id: tx.txid,
        chain: 'bitcoin',
        title:
          direction === 'incoming'
            ? 'Received BTC'
            : direction === 'outgoing'
            ? 'Sent BTC'
            : 'Bitcoin transfer',
        subtitle: tx?.status?.confirmed ? 'Bitcoin' : 'Bitcoin · Pending',
        amountText: `${sign}${satoshisToBTCString(Math.abs(net))} BTC`,
        fiatText: null,
        timestamp,
        txHash: tx.txid,
        status: tx?.status?.confirmed ? 'confirmed' : 'pending',
        direction,
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export default async function handler(req, res) {
  const debug = {
    environment: {
      hasPrivyAppId: Boolean(PRIVY_APP_ID),
      hasPrivyAppSecret: Boolean(PRIVY_APP_SECRET),
    },
    request: {
      method: req.method,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      hasBitcoinAddress: typeof req.query.bitcoinAddress === 'string',
    },
    checkpoints: [],
  };

  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      error: 'Method not allowed',
      debug,
    });
  }

  try {
    const accessToken = getBearerToken(req);
    debug.checkpoints.push({
      step: 'bearer-token',
      present: Boolean(accessToken),
    });
    logStep('activity:start', {
      hasBearer: Boolean(accessToken),
      hasBitcoinAddress: typeof req.query.bitcoinAddress === 'string',
    });

    if (!accessToken) {
      return sendJson(res, 401, {
        error: 'Missing bearer token',
        debug,
      });
    }

    const bitcoinAddress =
      typeof req.query.bitcoinAddress === 'string'
        ? req.query.bitcoinAddress
        : undefined;

    const currentUser = await getCurrentPrivyUser(accessToken);
    debug.checkpoints.push({
      step: 'current-user',
      privyUserId: currentUser.id,
    });
    logStep('activity:user', { privyUserId: currentUser.id });

    const wallets = await getWalletsForUser(currentUser.id);
    debug.checkpoints.push({
      step: 'wallets-loaded',
      walletCount: wallets.length,
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        chain_type: wallet.chain_type,
        address: wallet.address,
      })),
    });
    logStep('activity:wallets', {
      walletCount: wallets.length,
      walletChains: wallets.map((wallet) => ({
        id: wallet.id,
        chain_type: wallet.chain_type,
        address: wallet.address,
      })),
    });

    const evmWallet = pickWallet(wallets, 'ethereum');
    const solanaWallet = pickWallet(wallets, 'solana');

    debug.checkpoints.push({
      step: 'wallets-selected',
      evmWalletId: evmWallet?.id ?? null,
      evmWalletAddress: evmWallet?.address ?? null,
      solanaWalletId: solanaWallet?.id ?? null,
      solanaWalletAddress: solanaWallet?.address ?? null,
      bitcoinAddress: bitcoinAddress ?? null,
    });
    logStep('activity:selected-wallets', {
      evmWalletId: evmWallet?.id ?? null,
      solanaWalletId: solanaWallet?.id ?? null,
      bitcoinAddress: bitcoinAddress ?? null,
    });

    const [baseTxs, solTxs, btcTxs] = await Promise.all([
      evmWallet ? getPrivyTransactions(evmWallet.id, 'base') : Promise.resolve([]),
      solanaWallet ? getPrivyTransactions(solanaWallet.id, 'solana') : Promise.resolve([]),
      getBitcoinActivity(bitcoinAddress),
    ]);

    debug.checkpoints.push({
      step: 'transactions-fetched',
      baseCount: baseTxs.length,
      solanaCount: solTxs.length,
      bitcoinCount: btcTxs.length,
    });
    logStep('activity:transactions-fetched', {
      baseCount: baseTxs.length,
      solanaCount: solTxs.length,
      bitcoinCount: btcTxs.length,
    });

    const items = [
      ...baseTxs.map((tx) => mapPrivyTransaction(tx, 'base')).filter(Boolean),
      ...solTxs.map((tx) => mapPrivyTransaction(tx, 'solana')).filter(Boolean),
      ...btcTxs,
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    debug.checkpoints.push({
      step: 'items-mapped',
      itemCount: items.length,
      preview: items.slice(0, 10),
    });
    logStep('activity:items-mapped', {
      itemCount: items.length,
    });

    return sendJson(res, 200, {
      items,
      debug,
    });
  } catch (error) {
    debug.checkpoints.push({
      step: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });

    logError('activity:error', error, { debug });

    return sendJson(res, 500, {
      error: 'Failed to load activity',
      debug,
    });
  }
}
