const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_ORIGIN = process.env.PRIVY_ORIGIN || 'https://api.koppi.app';

const userCache = new Map();

// Historical USD price cache, keyed by `${coingeckoId}:${dd-mm-yyyy}`. Caches
// the in-flight Promise (not just the resolved value) so concurrent requests
// for the same asset/day within a single cold start dedupe onto one fetch.
const priceCache = new Map();

function coingeckoIdForSymbol(symbol) {
  switch (String(symbol || '').toLowerCase()) {
    case 'eth':
      return 'ethereum';
    case 'sol':
      return 'solana';
    case 'btc':
      return 'bitcoin';
    default:
      return null;
  }
}

function formatDateForCoingecko(value) {
  const d = value instanceof Date ? value : new Date(value);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Historical daily USD price for a CoinGecko coin id on the day of
// `timestamp` (CoinGecko's `/coins/{id}/history` endpoint is daily-
// granularity only — there's no intraday historical price on the free
// tier). Returns `null` on any failure so callers can fall back gracefully
// instead of breaking the whole activity feed over a pricing hiccup.
function getHistoricalPriceUSD(coingeckoId, timestamp) {
  const dateStr = formatDateForCoingecko(timestamp);
  const cacheKey = `${coingeckoId}:${dateStr}`;

  if (priceCache.has(cacheKey)) {
    return priceCache.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coingeckoId}/history?date=${dateStr}&localization=false`,
        { headers: { Accept: 'application/json' } }
      );
      if (!response.ok) return null;
      const data = await response.json();
      const price = data?.market_data?.current_price?.usd;
      return typeof price === 'number' && Number.isFinite(price) ? price : null;
    } catch {
      return null;
    }
  })();

  priceCache.set(cacheKey, promise);
  return promise;
}

// Attaches `fiatText` (signed, e.g. "+$0.96" / "-$0.04") to each item based
// on the USD price on the day the transaction happened, using each item's
// internal `_assetSymbol`/`_rawAmount` (stripped before the response is
// sent). Falls back to `fiatText: null` for anything we can't price.
async function enrichWithFiat(items) {
  return Promise.all(
    items.map(async (item) => {
      const { _assetSymbol, _rawAmount, ...rest } = item;
      const coingeckoId = coingeckoIdForSymbol(_assetSymbol);

      if (!coingeckoId || !(_rawAmount > 0)) {
        return { ...rest, fiatText: null };
      }

      const price = await getHistoricalPriceUSD(coingeckoId, item.timestamp);
      if (price === null) {
        return { ...rest, fiatText: null };
      }

      const fiatValue = _rawAmount * price;
      const sign = item.direction === 'incoming' ? '+' : item.direction === 'outgoing' ? '-' : '';
      return { ...rest, fiatText: `${sign}$${fiatValue.toFixed(2)}` };
    })
  );
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchCurrentPrivyUserOnce(accessToken) {
  const response = await fetch('https://auth.privy.io/api/v1/users/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'privy-app-id': PRIVY_APP_ID,
      Origin: PRIVY_ORIGIN,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Privy auth error ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
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

async function getCurrentPrivyUser(accessToken) {
  const cached = userCache.get(accessToken);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let lastError = null;
  const delays = [0, 800, 1800, 3500];

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);

    try {
      const user = await fetchCurrentPrivyUserOnce(accessToken);
      userCache.set(accessToken, {
        value: user,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      return user;
    } catch (error) {
      lastError = error;
      if (error?.status !== 429) throw error;
    }
  }

  throw lastError || new Error('Failed to load current Privy user');
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

function safeDisplayNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeTimestamp(value) {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}

function symbolForAsset(asset, chain) {
  const normalized = String(asset || '').toLowerCase();
  if (normalized === 'eth') return 'ETH';
  if (normalized === 'sol') return 'SOL';
  if (normalized === 'btc') return 'BTC';
  return chain === 'base' ? 'ETH' : chain === 'solana' ? 'SOL' : 'BTC';
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

  if (display) return `${sign}${display} ${symbol}`;

  const raw = safeDisplayNumber(detail.raw_value || 0);
  const decimals = safeDisplayNumber(detail.raw_value_decimals || 0) ?? 0;

  if (raw === null) return `${sign}0 ${symbol}`;

  const value = decimals > 0 ? raw / Math.pow(10, decimals) : raw;
  return `${sign}${value} ${symbol}`;
}

// Numeric (unsigned) amount for a Privy transfer, used only for the fiat
// multiplication in `enrichWithFiat` — never for display, since converting
// through `Number` can flip very small values into scientific notation
// (`formatPrivyAmount` keeps the original decimal string for display).
function numericPrivyAmount(detail, chain) {
  const key = String(detail.asset || '').toLowerCase();
  const display =
    detail.display_values?.[key] ??
    detail.display_values?.amount ??
    detail.display_values?.display_amount ??
    null;

  if (display) {
    const n = Number(display);
    if (Number.isFinite(n)) return Math.abs(n);
  }

  const raw = safeDisplayNumber(detail.raw_value || 0);
  const decimals = safeDisplayNumber(detail.raw_value_decimals || 0) ?? 0;
  if (raw === null) return 0;

  return Math.abs(decimals > 0 ? raw / Math.pow(10, decimals) : raw);
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

  // Per Privy's schema, `sender`/`recipient` are always both present on a
  // transfer, regardless of direction — the "other side" of the transfer is
  // the sender when we received it, the recipient when we sent it.
  const counterpartyAddress = isIncoming ? detail.sender || null : detail.recipient || null;

  return {
    id: tx.privy_transaction_id || tx.id || tx.transaction_hash || `${chain}-${tx.created_at}`,
    chain,
    title: isIncoming ? 'Received' : 'Sent',
    subtitle: chain === 'base' ? 'Base' : chain === 'solana' ? 'Solana' : 'Bitcoin',
    amountText: formatPrivyAmount(detail, chain),
    fiatText: null,
    timestamp: normalizeTimestamp(tx.created_at),
    txHash: tx.transaction_hash || null,
    status: tx.status || 'confirmed',
    direction,
    counterpartyAddress,
    // Internal-only fields consumed by `enrichWithFiat`, stripped before
    // the response is sent.
    _assetSymbol: symbol,
    _rawAmount: numericPrivyAmount(detail, chain),
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

// Best-effort external counterparty for a Bitcoin tx: for an outgoing
// payment, the first output that isn't back to our own address; for an
// incoming one, the first input's previous output that isn't ours. Bitcoin
// transactions can have multiple inputs/outputs (batched payments, change
// outputs, coin selection), so this is a heuristic — it picks the first
// external address, not necessarily "the" counterparty for multi-recipient
// transactions.
function pickBitcoinCounterpartyAddress(tx, address, direction) {
  if (direction === 'outgoing') {
    const vout = (tx.vout || []).find(
      (out) => out.scriptpubkey_address && out.scriptpubkey_address !== address
    );
    return vout?.scriptpubkey_address || null;
  }

  if (direction === 'incoming') {
    const vin = (tx.vin || []).find(
      (input) => input.prevout?.scriptpubkey_address && input.prevout.scriptpubkey_address !== address
    );
    return vin?.prevout?.scriptpubkey_address || null;
  }

  return null;
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
        title: direction === 'incoming' ? 'Received' : direction === 'outgoing' ? 'Sent' : 'Bitcoin transfer',
        subtitle: tx?.status?.confirmed ? 'Bitcoin' : 'Bitcoin · Pending',
        amountText: `${sign}${satoshisToBTCString(Math.abs(net))} BTC`,
        fiatText: null,
        timestamp,
        txHash: tx.txid,
        status: tx?.status?.confirmed ? 'confirmed' : 'pending',
        direction,
        counterpartyAddress: pickBitcoinCounterpartyAddress(tx, bitcoinAddress, direction),
        // Internal-only fields consumed by `enrichWithFiat`, stripped
        // before the response is sent.
        _assetSymbol: 'BTC',
        _rawAmount: Math.abs(net) / 100000000,
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function getPrivyTransactionsForWallet(walletId, chain) {
  // Privy's `/v1/wallets/{id}/transactions` endpoint doesn't support
  // Bitcoin at all — its `chain` enum only covers EVM chains + Solana, and
  // there's no valid `asset` value for BTC either (confirmed by the 400
  // error this used to throw: "Invalid enum value ... received 'bitcoin'").
  // Bitcoin activity comes exclusively from `getBitcoinActivity` (Blockstream)
  // below, so skip calling Privy for this chain entirely.
  if (chain === 'bitcoin') {
    return [];
  }

  const params = new URLSearchParams({
    chain,
    limit: '50',
  });

  // Both remaining chains use the `asset` query param (native asset
  // symbol) to filter transactions server-side. Solana previously used
  // `token`, which Privy's API rejects with a 400 unless it's a real
  // mint/contract address — `asset` is the correct param here.
  if (chain === 'base') {
    params.set('asset', 'eth');
  } else if (chain === 'solana') {
    params.set('asset', 'sol');
  }

  const response = await privyFetch(
    `/v1/wallets/${walletId}/transactions?${params.toString()}`
  );

  return response.transactions || response.data || [];
}

export default async function handler(req, res) {
  const debug = {
    environment: {
      hasPrivyAppId: Boolean(PRIVY_APP_ID),
      hasPrivyAppSecret: Boolean(PRIVY_APP_SECRET),
      privyOrigin: PRIVY_ORIGIN,
    },
    request: {
      method: req.method,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      hasBitcoinAddress: typeof req.query.bitcoinAddress === 'string',
    },
    checkpoints: [],
  };

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed', debug });
  }

  try {
    const accessToken = getBearerToken(req);
    debug.checkpoints.push({ step: 'bearer-token', present: Boolean(accessToken) });
    logStep('activity:start', {
      hasBearer: Boolean(accessToken),
      hasBitcoinAddress: typeof req.query.bitcoinAddress === 'string',
    });

    if (!accessToken) {
      return sendJson(res, 401, { error: 'Missing bearer token', debug });
    }

    const bitcoinAddress =
      typeof req.query.bitcoinAddress === 'string'
        ? req.query.bitcoinAddress
        : undefined;

    const currentUser = await getCurrentPrivyUser(accessToken);
    debug.checkpoints.push({ step: 'current-user', privyUserId: currentUser.id });
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
    const bitcoinWallet = pickWallet(wallets, 'bitcoin-segwit');

    debug.checkpoints.push({
      step: 'wallets-selected',
      evmWalletId: evmWallet?.id ?? null,
      evmWalletAddress: evmWallet?.address ?? null,
      solanaWalletId: solanaWallet?.id ?? null,
      solanaWalletAddress: solanaWallet?.address ?? null,
      bitcoinWalletId: bitcoinWallet?.id ?? null,
      bitcoinAddress: bitcoinAddress ?? bitcoinWallet?.address ?? null,
    });
    logStep('activity:selected-wallets', {
      evmWalletId: evmWallet?.id ?? null,
      solanaWalletId: solanaWallet?.id ?? null,
      bitcoinAddress: bitcoinAddress ?? bitcoinWallet?.address ?? null,
    });

    const [baseTxs, solTxs, btcTxs, bitcoinActivity] = await Promise.all([
      evmWallet ? getPrivyTransactionsForWallet(evmWallet.id, 'base') : Promise.resolve([]),
      solanaWallet ? getPrivyTransactionsForWallet(solanaWallet.id, 'solana') : Promise.resolve([]),
      bitcoinWallet ? getPrivyTransactionsForWallet(bitcoinWallet.id, 'bitcoin') : Promise.resolve([]),
      getBitcoinActivity(bitcoinAddress ?? bitcoinWallet?.address),
    ]);

    debug.checkpoints.push({
      step: 'transactions-fetched',
      baseCount: baseTxs.length,
      solanaCount: solTxs.length,
      bitcoinCount: btcTxs.length,
      bitcoinChainActivityCount: bitcoinActivity.length,
    });
    logStep('activity:transactions-fetched', {
      baseCount: baseTxs.length,
      solanaCount: solTxs.length,
      bitcoinCount: btcTxs.length,
      bitcoinChainActivityCount: bitcoinActivity.length,
    });

    const rawItems = [
      ...baseTxs.map((tx) => mapPrivyTransaction(tx, 'base')).filter(Boolean),
      ...solTxs.map((tx) => mapPrivyTransaction(tx, 'solana')).filter(Boolean),
      ...btcTxs.map((tx) => mapPrivyTransaction(tx, 'bitcoin')).filter(Boolean),
      ...bitcoinActivity,
    ];

    // Attach a signed USD fiat value (priced on the day the transaction
    // happened) and strip the internal `_assetSymbol`/`_rawAmount` fields
    // used to compute it.
    const items = (await enrichWithFiat(rawItems)).sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    debug.checkpoints.push({
      step: 'items-mapped',
      itemCount: items.length,
      preview: items.slice(0, 10),
    });
    logStep('activity:items-mapped', { itemCount: items.length });

    return sendJson(res, 200, { items, debug });
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
