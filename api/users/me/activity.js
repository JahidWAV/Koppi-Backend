const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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

async function getCurrentPrivyUserId(accessToken) {
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
  const userId = data?.user?.id ?? data?.id;

  if (!userId) {
    throw new Error('Could not resolve current Privy user id');
  }

  return userId;
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

function formatPrivyAmount(detail, chain) {
  const symbol = symbolForAsset(detail.asset, chain);
  const key = String(detail.asset || '').toLowerCase();
  const display = detail.display_values && detail.display_values[key];
  const sign = detail.type === 'transfer_received' ? '+' : '-';

  if (display) {
    return `${sign}${display} ${symbol}`;
  }

  const raw = Number(detail.raw_value || 0);
  const decimals = Number(detail.raw_value_decimals || 0);
  const value = decimals > 0 ? raw / Math.pow(10, decimals) : raw;

  return `${sign}${value} ${symbol}`;
}

function mapPrivyTransaction(tx, chain) {
  if (!tx || !tx.details) return null;

  const detail = tx.details;
  if (detail.type !== 'transfer_sent' && detail.type !== 'transfer_received') {
    return null;
  }

  const direction = detail.type === 'transfer_received' ? 'incoming' : 'outgoing';
  const symbol = symbolForAsset(detail.asset, chain);
  const isIncoming = direction === 'incoming';

  return {
    id: tx.privy_transaction_id || tx.transaction_hash || `${chain}-${tx.created_at}`,
    chain,
    title: isIncoming ? `Received ${symbol}` : `Sent ${symbol}`,
    subtitle: chain === 'base' ? 'Base' : 'Solana',
    amountText: formatPrivyAmount(detail, chain),
    fiatText: null,
    timestamp: new Date(tx.created_at).toISOString(),
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
      const timestamp = new Date((tx.status && tx.status.block_time ? tx.status.block_time : 0) * 1000).toISOString();

      return {
        id: tx.txid,
        chain: 'bitcoin',
        title:
          direction === 'incoming'
            ? 'Received BTC'
            : direction === 'outgoing'
            ? 'Sent BTC'
            : 'Bitcoin transfer',
        subtitle: tx.status && tx.status.confirmed ? 'Bitcoin' : 'Bitcoin · Pending',
        amountText: `${sign}${satoshisToBTCString(Math.abs(net))} BTC`,
        fiatText: null,
        timestamp,
        txHash: tx.txid,
        status: tx.status && tx.status.confirmed ? 'confirmed' : 'pending',
        direction,
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return sendJson(res, 401, { error: 'Missing bearer token' });
    }

    const bitcoinAddress =
      typeof req.query.bitcoinAddress === 'string'
        ? req.query.bitcoinAddress
        : undefined;

    const privyUserId = await getCurrentPrivyUserId(accessToken);
    const wallets = await getWalletsForUser(privyUserId);

    const evmWallet = pickWallet(wallets, 'ethereum');
    const solanaWallet = pickWallet(wallets, 'solana');

    const [baseTxs, solTxs, btcTxs] = await Promise.all([
      evmWallet ? getPrivyTransactions(evmWallet.id, 'base') : Promise.resolve([]),
      solanaWallet ? getPrivyTransactions(solanaWallet.id, 'solana') : Promise.resolve([]),
      getBitcoinActivity(bitcoinAddress),
    ]);

    const items = [
      ...baseTxs.map((tx) => mapPrivyTransaction(tx, 'base')).filter(Boolean),
      ...solTxs.map((tx) => mapPrivyTransaction(tx, 'solana')).filter(Boolean),
      ...btcTxs,
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return sendJson(res, 200, { items });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 500, {
      error: 'Failed to load activity',
      details: message,
    });
  }
};
