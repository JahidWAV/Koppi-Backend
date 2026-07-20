import { Buffer } from 'node:buffer';
import { getBearerToken, verifyPrivyAccessToken } from '../../../lib/privy.js';

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE_URL = 'https://api.privy.io';
const ESPLORA_BASE_URL = 'https://blockstream.info/api';

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function basicAuthHeader(appId, appSecret) {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
}

async function fetchJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }

  if (!response.ok) {
    console.error(`${label} error`, response.status, json ?? text);
    throw new Error(`${label} failed: ${response.status}`);
  }

  return json;
}

async function fetchPrivyUserById(userId) {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  return fetchJson(
    `${PRIVY_BASE_URL}/v1/users/${userId}`,
    {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(appId, appSecret),
        'privy-app-id': appId,
        Accept: 'application/json',
      },
    },
    'Privy get user'
  );
}

function extractWalletsFromUserResponse(payload) {
  const user = payload?.data ?? payload?.user ?? payload;

  const linkedAccounts = user?.linked_accounts ?? user?.linkedAccounts ?? [];
  const wallets = [];

  for (const account of linkedAccounts) {
    const address = account?.address;
    const id = account?.id;
    const type = account?.type;
    const chainType = account?.chain_type ?? account?.chainType;

    const isWalletLike =
      type === 'wallet' ||
      type === 'ethereum_wallet' ||
      type === 'solana_wallet' ||
      type === 'cross_app_wallet' ||
      type === 'smart_wallet' ||
      String(type || '').includes('wallet');

    if (isWalletLike && address) {
      wallets.push({
        id,
        address,
        chainType,
        type,
      });
    }
  }

  return wallets;
}

function findWalletIdByAddress(wallets, address, expectedChainType) {
  if (!address) return null;

  const normalizedAddress = String(address).toLowerCase();

  const exactChainMatch = wallets.find(
    (wallet) =>
      wallet.address?.toLowerCase() === normalizedAddress &&
      (!expectedChainType ||
        String(wallet.chainType || '').toLowerCase() === expectedChainType.toLowerCase())
  );

  if (exactChainMatch?.id) return exactChainMatch.id;

  const fallbackMatch = wallets.find(
    (wallet) => wallet.address?.toLowerCase() === normalizedAddress
  );

  return fallbackMatch?.id ?? null;
}

async function fetchWalletBalance(walletId, asset, chain) {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = new URL(`${PRIVY_BASE_URL}/v1/wallets/${walletId}/balance`);
  const assets = Array.isArray(asset) ? asset : [asset];
  const chains = Array.isArray(chain) ? chain : [chain];

  for (const a of assets) url.searchParams.append('asset', a);
  for (const c of chains) url.searchParams.append('chain', c);
  url.searchParams.set('include_currency', 'usd');

  return fetchJson(
    url.toString(),
    {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(appId, appSecret),
        'privy-app-id': appId,
        Accept: 'application/json',
      },
    },
    'Privy wallet balance'
  );
}

async function fetchBitcoinBalance(address) {
  const fundedJson = await fetchJson(
    `${ESPLORA_BASE_URL}/address/${address}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    'Esplora address'
  );

  const funded = fundedJson.chain_stats?.funded_txo_sum || 0;
  const spent = fundedJson.chain_stats?.spent_txo_sum || 0;
  const sats = funded - spent;
  const btcAmount = sats / 100000000;

  const priceJson = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { method: 'GET', headers: { Accept: 'application/json' } },
    'CoinGecko BTC price'
  );

  const btcUsd = Number(priceJson?.bitcoin?.usd || 0);

  return {
    symbol: 'BTC',
    amount: btcAmount.toString(),
    fiatValue: (btcAmount * btcUsd).toFixed(2),
  };
}

function normalizeEntry(entries, chain, assetKey, symbol) {
  const match = (entries || []).find(
    (item) =>
      String(item.chain || '').toLowerCase() === chain.toLowerCase() &&
      String(item.asset || '').toLowerCase() === assetKey.toLowerCase()
  );

  return {
    symbol,
    amount: match?.display_values?.[assetKey] || '0',
    fiatValue: match?.display_values?.usd || '0',
  };
}

function sumFiat(...values) {
  return values
    .map((v) => Number(v || '0'))
    .filter((v) => Number.isFinite(v))
    .reduce((sum, value) => sum + value, 0);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('balances route invoked', {
    method: req.method,
    url: req.url,
    query: req.query,
  });

  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing bearer token' });
    }

    const claims = await verifyPrivyAccessToken(token);
    const userId = claims?.sub || claims?.userId || claims?.user_id;

    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Missing Privy user id in token claims' });
    }

    const { evmAddress, solanaAddress, bitcoinAddress } = req.query;

    const userPayload = await fetchPrivyUserById(userId);
    const wallets = extractWalletsFromUserResponse(userPayload);

    const evmWalletId = findWalletIdByAddress(wallets, evmAddress, 'ethereum');
    const solanaWalletId = findWalletIdByAddress(wallets, solanaAddress, 'solana');

    console.log('resolved wallet ids', {
      userId,
      evmAddress,
      evmWalletId,
      solanaAddress,
      solanaWalletId,
      bitcoinAddress,
      walletCount: wallets.length,
    });

    const [evmResponse, solanaResponse, bitcoin] = await Promise.all([
      evmWalletId
        ? fetchWalletBalance(
            evmWalletId,
            ['eth', 'pol'],
            ['ethereum', 'base', 'arbitrum', 'polygon']
          )
        : Promise.resolve({ balances: [] }),
      solanaWalletId
        ? fetchWalletBalance(solanaWalletId, 'sol', 'solana')
        : Promise.resolve({ balances: [] }),
      bitcoinAddress
        ? fetchBitcoinBalance(bitcoinAddress)
        : Promise.resolve({ symbol: 'BTC', amount: '0', fiatValue: '0' }),
    ]);

    const evmEntries = evmResponse.balances || evmResponse.data?.balances || [];
    const solEntries = solanaResponse.balances || solanaResponse.data?.balances || [];

    const ethereum = normalizeEntry(evmEntries, 'ethereum', 'eth', 'ETH');
    const base = normalizeEntry(evmEntries, 'base', 'eth', 'ETH');
    const arbitrum = normalizeEntry(evmEntries, 'arbitrum', 'eth', 'ETH');
    const polygon = normalizeEntry(evmEntries, 'polygon', 'pol', 'POL');
    const solana = normalizeEntry(solEntries, 'solana', 'sol', 'SOL');

    const evmTotalAmount =
      (Number(ethereum.amount || '0') || 0) +
      (Number(base.amount || '0') || 0) +
      (Number(arbitrum.amount || '0') || 0) +
      (Number(polygon.amount || '0') || 0);

    const evmTotalFiat = sumFiat(
      ethereum.fiatValue,
      base.fiatValue,
      arbitrum.fiatValue,
      polygon.fiatValue
    );

    return res.status(200).json({
      ok: true,
      balances: {
        evm: {
          symbol: 'EVM',
          amount: String(evmTotalAmount),
          fiatValue: evmTotalFiat.toFixed(2),
        },
        solana,
        bitcoin,
      },
      networks: {
        ethereum,
        base,
        arbitrum,
        polygon,
        solana,
      },
      resolvedWallets: {
        evmWalletId,
        solanaWalletId,
      },
    });
  } catch (error) {
    console.error('GET /api/users/me/balances error', error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch balances',
    });
  }
}
