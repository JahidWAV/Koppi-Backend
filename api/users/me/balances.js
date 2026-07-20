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
  } catch {
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

async function getPrivyAccountBalance(accountId) {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = `${PRIVY_BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/balance`;

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
    console.error('Privy account balance error', response.status, text);
    throw new Error(`Failed to fetch Privy account balance: ${response.status}`);
  }

  return parseJson(text, 'Privy account balance');
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

function toSafeNumber(value) {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapAssetsToNetworks(assets) {
  const find = (symbol, chainList) =>
    (assets || []).find((a) => {
      const s = String(a.symbol || '').toUpperCase();
      const chain = String(a.chain || '').toLowerCase();
      return s === symbol.toUpperCase() && chainList.includes(chain);
    });

  const pick = (asset, fallbackSymbol) => {
    if (!asset) {
      return {
        symbol: fallbackSymbol,
        amount: '0',
        fiatValue: '0',
      };
    }

    return {
      symbol: asset.symbol || fallbackSymbol,
      amount: asset.amount || '0',
      fiatValue: asset.value || '0',
    };
  };

  return {
    ethereum: pick(find('ETH', ['ethereum']), 'ETH'),
    base: pick(find('ETH', ['base']), 'ETH'),
    arbitrum: pick(find('ETH', ['arbitrum']), 'ETH'),
    polygon: pick(find('POL', ['polygon']), 'POL'),
    solana: pick(find('SOL', ['solana']), 'SOL'),
  };
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
    const accountId = debugUser.claims.rawClaims?.accountId || debugUser.claims.rawClaims?.account_id || null;

    console.log('Using Privy user id', privyUserId);
    console.log('Using Privy account id', accountId);

    let privyBalance = null;

    if (accountId) {
      privyBalance = await getPrivyAccountBalance(accountId);
    }

    const assets = privyBalance?.assets || [];
    const networks = mapAssetsToNetworks(assets);

    const bitcoinBalance = await fetchBitcoinBalanceFromKoppi(token);

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
      networks.ethereum.fiatValue,
      networks.base.fiatValue,
      networks.arbitrum.fiatValue,
      networks.polygon.fiatValue,
      networks.solana.fiatValue,
      bitcoin.fiatValue,
      privyBalance?.total?.value,
    ]
      .map(toSafeNumber)
      .reduce((sum, value) => sum + value, 0)
      .toFixed(2);

    return res.status(200).json({
      ok: true,
      privyUserId,
      accountId,
      balances: {
        ethereum: { chain: 'ethereum', symbol: 'ETH', ...networks.ethereum },
        base: { chain: 'base', symbol: 'ETH', ...networks.base },
        arbitrum: { chain: 'arbitrum', symbol: 'ETH', ...networks.arbitrum },
        polygon: { chain: 'polygon', symbol: 'POL', ...networks.polygon },
        solana: { chain: 'solana', symbol: 'SOL', ...networks.solana },
        bitcoin,
      },
      totalUsd,
      privyRaw: privyBalance || null,
    });
  } catch (error) {
    console.error('GET /api/users/me/balances error', error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch balances',
    });
  }
}
