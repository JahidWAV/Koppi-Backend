import { Buffer } from 'node:buffer';

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE_URL = 'https://api.privy.io';
const KOPPI_BASE_URL = 'https://api.koppi.app';

function basicAuthHeader(appId, appSecret) {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`${label} invalid JSON`, text);
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function getAuthenticatedUser(token) {
  const response = await fetch(`${KOPPI_BASE_URL}/api/users/me/debug-token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('debug-token failed', response.status, text);
    return null;
  }

  return parseJson(text, 'debug-token');
}

async function getPrivyUserWallets(privyUserId) {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = `${PRIVY_BASE_URL}/v1/wallets?owner_id=${encodeURIComponent(privyUserId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(appId, appSecret),
      'privy-app-id': appId,
      Accept: 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('Privy wallets error', response.status, text);
    throw new Error(`Failed to fetch Privy wallets: ${response.status}`);
  }

  const parsed = parseJson(text, 'Privy wallets');
  const wallets = Array.isArray(parsed) ? parsed : parsed.wallets || parsed.data || parsed.results || [];

  console.log('Privy wallets fetched', wallets);
  return wallets;
}

async function fetchWalletBalance(walletId, asset, chain) {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = new URL(`${PRIVY_BASE_URL}/v1/wallets/${walletId}/balance`);
  const assets = Array.isArray(asset) ? asset : [asset];
  const chains = Array.isArray(chain) ? chain : [chain];

  assets.forEach((a) => url.searchParams.append('asset', a));
  chains.forEach((c) => url.searchParams.append('chain', c));
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
      asset: assets,
      chain: chains,
    });
    throw new Error(`Failed wallet balance fetch: ${response.status}`);
  }

  return parseJson(text, 'Privy wallet balance');
}

async function fetchBitcoinBalanceFromKoppi(token) {
  const response = await fetch(`${KOPPI_BASE_URL}/api/users/me/wallets/bitcoin/balance`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('Bitcoin balance route error', response.status, text);
    return null;
  }

  return parseJson(text, 'Bitcoin balance');
}

function normalizeEntry(entries, chain, assetKey, fallbackSymbol) {
  const entry = (entries || []).find(
    (item) =>
      String(item.chain || '').toLowerCase() === chain.toLowerCase() &&
      String(item.asset || '').toLowerCase() === assetKey.toLowerCase()
  );

  return {
    chain,
    symbol: fallbackSymbol,
    amount: entry?.display_values?.[assetKey.toLowerCase()] || '0',
    fiatValue: entry?.display_values?.usd || '0',
    rawValue: entry?.raw_value || '0',
    decimals: entry?.raw_value_decimals || 0,
  };
}

function toSafeNumber(value) {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('balances route invoked', {
    method: req.method,
    url: req.url,
  });

  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const debugUser = await getAuthenticatedUser(token);

    if (!debugUser?.claims?.userId) {
      return res.status(401).json({
        error: 'Missing Privy user id in token claims',
        debugUser,
      });
    }

    const privyUserId = debugUser.claims.userId;
    console.log('Using Privy user id', privyUserId);

    const wallets = await getPrivyUserWallets(privyUserId);

    const evmWallet =
      wallets.find((wallet) => wallet.chain_type === 'ethereum') ||
      wallets.find((wallet) => wallet.wallet_client_type === 'privy') ||
      wallets.find((wallet) => wallet.chain_type === 'base') ||
      wallets.find((wallet) => wallet.chain_type === 'arbitrum') ||
      wallets.find((wallet) => wallet.chain_type === 'polygon');

    const solanaWallet = wallets.find((wallet) => wallet.chain_type === 'solana') || null;

    if (!evmWallet?.id) {
      return res.status(400).json({
        error: 'No EVM wallet found for this Privy user',
        privyUserId,
        wallets,
      });
    }

    const [evmBalances, solBalances, bitcoinBalance] = await Promise.all([
      fetchWalletBalance(evmWallet.id, ['eth', 'pol'], ['ethereum', 'base', 'arbitrum', 'polygon']),
      solanaWallet?.id
        ? fetchWalletBalance(solanaWallet.id, 'sol', 'solana')
        : Promise.resolve({ balances: [] }),
      fetchBitcoinBalanceFromKoppi(token),
    ]);

    const evmEntries = evmBalances?.balances || [];
    const solEntries = solBalances?.balances || [];

    const ethereum = normalizeEntry(evmEntries, 'ethereum', 'eth', 'ETH');
    const base = normalizeEntry(evmEntries, 'base', 'eth', 'ETH');
    const arbitrum = normalizeEntry(evmEntries, 'arbitrum', 'eth', 'ETH');
    const polygon = normalizeEntry(evmEntries, 'polygon', 'pol', 'POL');
    const solana = normalizeEntry(solEntries, 'solana', 'sol', 'SOL');

    const bitcoin = bitcoinBalance
      ? {
          chain: 'bitcoin',
          symbol: bitcoinBalance.symbol || 'BTC',
          amount: bitcoinBalance.amount || '0',
          fiatValue: bitcoinBalance.fiatValue || '0',
        }
      : {
          chain: 'bitcoin',
          symbol: 'BTC',
          amount: '0',
          fiatValue: '0',
        };

    const totalUsd = [
      ethereum.fiatValue,
      base.fiatValue,
      arbitrum.fiatValue,
      polygon.fiatValue,
      solana.fiatValue,
      bitcoin.fiatValue,
    ]
      .map(toSafeNumber)
      .reduce((sum, value) => sum + value, 0)
      .toFixed(2);

    return res.status(200).json({
      ok: true,
      privyUserId,
      wallets: {
        evm: {
          id: evmWallet.id || null,
          address: evmWallet.address || null,
          chainType: evmWallet.chain_type || null,
        },
        solana: solanaWallet
          ? {
              id: solanaWallet.id || null,
              address: solanaWallet.address || null,
              chainType: solanaWallet.chain_type || null,
            }
          : null,
      },
      balances: {
        ethereum,
        base,
        arbitrum,
        polygon,
        solana,
        bitcoin,
      },
      totalUsd,
    });
  } catch (error) {
    console.error('GET /api/users/me/balances error', error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch balances',
    });
  }
}
