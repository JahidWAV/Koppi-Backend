import { Buffer } from 'node:buffer';

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

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
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

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(appId, appSecret),
      'privy-app-id': appId,
      Accept: 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('Privy wallet balance error', response.status, text, {
      walletId,
      assets,
      chains,
    });
    throw new Error(`Failed wallet balance fetch: ${response.status}`);
  }

  return parseJson(text, 'Privy wallet balance');
}

async function fetchBitcoinBalance(address) {
  const fundedRes = await fetch(`${ESPLORA_BASE_URL}/address/${address}`);
  if (!fundedRes.ok) {
    throw new Error(`Failed BTC address fetch: ${fundedRes.status}`);
  }

  const fundedJson = await fundedRes.json();
  const funded = fundedJson.chain_stats?.funded_txo_sum || 0;
  const spent = fundedJson.chain_stats?.spent_txo_sum || 0;
  const sats = funded - spent;
  const btcAmount = sats / 100000000;

  const priceRes = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
  );
  if (!priceRes.ok) {
    throw new Error(`Failed BTC price fetch: ${priceRes.status}`);
  }

  const priceJson = await priceRes.json();
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
    const { evmWalletId, solanaWalletId, bitcoinAddress } = req.query;

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

    const evmEntries = evmResponse.balances || [];
    const solEntries = solanaResponse.balances || [];

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
    });
  } catch (error) {
    console.error('GET /api/users/me/balances error', error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch balances',
    });
  }
}
