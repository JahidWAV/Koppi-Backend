import type { VercelRequest, VercelResponse } from '@vercel/node';

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE_URL = 'https://api.privy.io';
const KOPPI_BASE_URL = 'https://api.koppi.app';

type DebugTokenResponse = {
  ok?: boolean;
  claims?: {
    userId?: string;
    appId?: string;
    issuer?: string;
    sessionId?: string;
    rawClaims?: Record<string, unknown>;
  };
};

type WalletDescriptor = {
  id?: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  connector_type?: string;
  delegated?: boolean;
};

type PrivyWalletsResponse =
  | WalletDescriptor[]
  | {
      wallets?: WalletDescriptor[];
      data?: WalletDescriptor[];
      results?: WalletDescriptor[];
    };

type WalletBalanceEntry = {
  chain: string;
  asset: string;
  raw_value: string;
  raw_value_decimals: number;
  display_values?: Record<string, string>;
};

type WalletBalanceResponse = {
  balances?: WalletBalanceEntry[];
};

type BitcoinBalanceResponse = {
  symbol?: string;
  amount?: string;
  fiatValue?: string;
};

function requireEnv(name: string, value?: string): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function basicAuthHeader(appId: string, appSecret: string) {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
}

function parseWallets(payload: PrivyWalletsResponse): WalletDescriptor[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.wallets)) return payload.wallets;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}

async function getAuthenticatedUser(token: string): Promise<DebugTokenResponse | null> {
  const response = await fetch(`${KOPPI_BASE_URL}/api/users/me/debug-token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('debug-token failed', response.status, text);
    return null;
  }

  return response.json() as Promise<DebugTokenResponse>;
}

async function getPrivyUserWallets(privyUserId: string): Promise<WalletDescriptor[]> {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = `${PRIVY_BASE_URL}/v1/wallets?owner_id=${encodeURIComponent(privyUserId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(appId, appSecret),
      'privy-app-id': appId,
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    console.error('Privy wallets error', response.status, text);
    throw new Error(`Failed to fetch Privy wallets: ${response.status}`);
  }

  let parsed: PrivyWalletsResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('Privy wallets invalid JSON', text);
    throw new Error('Privy wallets returned invalid JSON');
  }

  const wallets = parseWallets(parsed);
  console.log('Privy wallets fetched', wallets);

  return wallets;
}

async function fetchWalletBalance(
  walletId: string,
  asset: string | string[],
  chain: string | string[]
): Promise<WalletBalanceResponse> {
  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = new URL(`${PRIVY_BASE_URL}/v1/wallets/${walletId}/balance`);

  const assets = Array.isArray(asset) ? asset : [asset];
  const chains = Array.isArray(chain) ? chain : [chain];

  for (const a of assets) {
    url.searchParams.append('asset', a);
  }

  for (const c of chains) {
    url.searchParams.append('chain', c);
  }

  url.searchParams.set('include_currency', 'usd');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(appId, appSecret),
      'privy-app-id': appId,
      'Content-Type': 'application/json',
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

  try {
    return JSON.parse(text) as WalletBalanceResponse;
  } catch {
    console.error('Privy wallet balance invalid JSON', text);
    throw new Error('Privy wallet balance returned invalid JSON');
  }
}

async function fetchBitcoinBalanceFromKoppi(token: string): Promise<BitcoinBalanceResponse | null> {
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

  try {
    return JSON.parse(text) as BitcoinBalanceResponse;
  } catch {
    console.error('Bitcoin balance invalid JSON', text);
    return null;
  }
}

function normalizeEntry(
  entries: WalletBalanceEntry[],
  chain: string,
  assetKey: string,
  fallbackSymbol: string
) {
  const entry = entries.find(
    (item) =>
      item.chain?.toLowerCase() === chain.toLowerCase() &&
      item.asset?.toLowerCase() === assetKey.toLowerCase()
  );

  return {
    chain,
    symbol: fallbackSymbol,
    amount: entry?.display_values?.[assetKey.toLowerCase()] ?? '0',
    fiatValue: entry?.display_values?.usd ?? '0',
    rawValue: entry?.raw_value ?? '0',
    decimals: entry?.raw_value_decimals ?? 0,
  };
}

function toSafeNumber(value?: string): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      wallets.find((wallet) => wallet.chain_type === 'ethereum') ??
      wallets.find((wallet) => wallet.wallet_client_type === 'privy');

    const solanaWallet =
      wallets.find((wallet) => wallet.chain_type === 'solana') ?? null;

    if (!evmWallet?.id) {
      return res.status(400).json({
        error: 'No EVM wallet found for this Privy user',
        privyUserId,
        wallets,
      });
    }

    const [evmBalances, solBalances, bitcoinBalance] = await Promise.all([
      fetchWalletBalance(
        evmWallet.id,
        ['eth', 'pol'],
        ['ethereum', 'base', 'arbitrum', 'polygon']
      ),
      solanaWallet?.id
        ? fetchWalletBalance(solanaWallet.id, 'sol', 'solana')
        : Promise.resolve({ balances: [] }),
      fetchBitcoinBalanceFromKoppi(token),
    ]);

    const evmEntries = evmBalances.balances ?? [];
    const solEntries = solBalances.balances ?? [];

    const ethereum = normalizeEntry(evmEntries, 'ethereum', 'eth', 'ETH');
    const base = normalizeEntry(evmEntries, 'base', 'eth', 'ETH');
    const arbitrum = normalizeEntry(evmEntries, 'arbitrum', 'eth', 'ETH');
    const polygon = normalizeEntry(evmEntries, 'polygon', 'pol', 'POL');
    const solana = normalizeEntry(solEntries, 'solana', 'sol', 'SOL');

    const bitcoin = bitcoinBalance
      ? {
          chain: 'bitcoin',
          symbol: bitcoinBalance.symbol ?? 'BTC',
          amount: bitcoinBalance.amount ?? '0',
          fiatValue: bitcoinBalance.fiatValue ?? '0',
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
          id: evmWallet.id ?? null,
          address: evmWallet.address ?? null,
          chainType: evmWallet.chain_type ?? null,
        },
        solana: solanaWallet
          ? {
              id: solanaWallet.id ?? null,
              address: solanaWallet.address ?? null,
              chainType: solanaWallet.chain_type ?? null,
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
