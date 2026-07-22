// api/users/me/activity.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type ActivityItem = {
  id: string;
  chain: string;
  title: string;
  subtitle: string;
  amountText: string;
  fiatText: string | null;
  timestamp: string;
  txHash: string | null;
  status: string;
  direction: 'incoming' | 'outgoing' | 'neutral';
};

type PrivyAuthUserResponse = {
  user?: {
    id: string;
  };
  id?: string;
};

type PrivyWallet = {
  id: string;
  address: string;
  chain_type: string;
  created_at?: number;
};

type PrivyWalletsResponse = {
  data: PrivyWallet[];
  next_cursor?: string | null;
};

type PrivyTransactionResponse = {
  transactions: PrivyTransaction[];
  next_cursor: string | null;
};

type PrivyTransaction = {
  caip2: string;
  transaction_hash: string | null;
  user_operation_hash?: string | null;
  status: string;
  created_at: number;
  sponsored?: boolean;
  privy_transaction_id: string;
  wallet_id: string;
  details: PrivyTransactionDetail | null;
};

type PrivyTransactionDetail =
  | {
      type: 'transfer_sent';
      chain: string;
      asset: string;
      sender: string;
      recipient: string;
      raw_value: string;
      raw_value_decimals: number;
      display_values?: Record<string, string>;
    }
  | {
      type: 'transfer_received';
      chain: string;
      asset: string;
      sender: string;
      recipient: string;
      raw_value: string;
      raw_value_decimals: number;
      display_values?: Record<string, string>;
    };

type BlockstreamTx = {
  txid: string;
  status: {
    confirmed: boolean;
    block_time?: number;
  };
  vin: Array<{
    prevout?: {
      scriptpubkey_address?: string;
      value?: number;
    };
  }>;
  vout: Array<{
    scriptpubkey_address?: string;
    value: number;
  }>;
};

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

function json(
  res: VercelResponse,
  status: number,
  body: Record<string, unknown>
) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function getBearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || Array.isArray(auth)) return null;
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim() || null;
}

function getPrivyBasicAuthHeader() {
  const raw = `${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

async function privyFetch<T>(path: string): Promise<T> {
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

  return (await response.json()) as T;
}

async function getCurrentPrivyUserId(accessToken: string): Promise<string> {
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

  const data = (await response.json()) as PrivyAuthUserResponse;
  const userId = data.user?.id ?? data.id;

  if (!userId) {
    throw new Error('Could not resolve current Privy user id');
  }

  return userId;
}

async function getWalletsForUser(userId: string): Promise<PrivyWallet[]> {
  const params = new URLSearchParams({
    user_id: userId,
    limit: '100',
  });

  const response = await privyFetch<PrivyWalletsResponse>(`/v1/wallets?${params.toString()}`);
  return response.data ?? [];
}

function pickWallet(
  wallets: PrivyWallet[],
  chainType: 'ethereum' | 'solana'
): PrivyWallet | null {
  const matches = wallets.filter((wallet) => wallet.chain_type === chainType);
  if (matches.length === 0) return null;

  matches.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return matches[0];
}

async function getPrivyTransactions(
  walletId: string,
  chain: 'base' | 'solana'
): Promise<PrivyTransaction[]> {
  const params = new URLSearchParams({
    chain,
    limit: '50',
  });

  const response = await privyFetch<PrivyTransactionResponse>(
    `/v1/wallets/${walletId}/transactions?${params.toString()}`
  );

  return response.transactions ?? [];
}

function symbolForAsset(asset: string, chain: 'base' | 'solana'): string {
  const normalized = asset.toLowerCase();
  if (normalized === 'eth') return 'ETH';
  if (normalized === 'sol') return 'SOL';
  if (normalized === 'usdc') return 'USDC';
  if (normalized === 'usdt') return 'USDT';
  return chain === 'base' ? 'ETH' : 'SOL';
}

function formatAmountFromDisplayValues(
  detail: PrivyTransactionDetail,
  chain: 'base' | 'solana'
): string {
  const symbol = symbolForAsset(detail.asset, chain);
  const key = detail.asset.toLowerCase();
  const display = detail.display_values?.[key];

  if (display) {
    const sign = detail.type === 'transfer_received' ? '+' : '-';
    return `${sign}${display} ${symbol}`;
  }

  const raw = BigInt(detail.raw_value || '0');
  const decimals = detail.raw_value_decimals ?? 0;
  const divisor = 10 ** Math.min(decimals, 18);
  const approx = Number(raw) / divisor;
  const sign = detail.type === 'transfer_received' ? '+' : '-';
  return `${sign}${approx} ${symbol}`;
}

function mapPrivyTransaction(
  tx: PrivyTransaction,
  chain: 'base' | 'solana'
): ActivityItem | null {
  if (!tx.details) return null;
  if (tx.details.type !== 'transfer_sent' && tx.details.type !== 'transfer_received') {
    return null;
  }

  const detail = tx.details;
  const direction = detail.type === 'transfer_received' ? 'incoming' : 'outgoing';
  const symbol = symbolForAsset(detail.asset, chain);
  const isReceived = direction === 'incoming';

  return {
    id: tx.privy_transaction_id,
    chain,
    title: isReceived ? `Received ${symbol}` : `Sent ${symbol}`,
    subtitle: chain === 'base' ? 'Base' : 'Solana',
    amountText: formatAmountFromDisplayValues(detail, chain),
    fiatText: null,
    timestamp: new Date(tx.created_at).toISOString(),
    txHash: tx.transaction_hash,
    status: tx.status,
    direction,
  };
}

function satoshisToBTCString(value: number): string {
  const btc = value / 100_000_000;
  return btc.toFixed(8).replace(/\.?0+$/, '');
}

function netValueForBitcoinAddress(tx: BlockstreamTx, address: string): number {
  const received = tx.vout
    .filter((out) => out.scriptpubkey_address === address)
    .reduce((sum, out) => sum + out.value, 0);

  const spent = tx.vin
    .filter((input) => input.prevout?.scriptpubkey_address === address)
    .reduce((sum, input) => sum + (input.prevout?.value ?? 0), 0);

  return received - spent;
}

async function getBitcoinActivity(bitcoinAddress?: string): Promise<ActivityItem[]> {
  if (!bitcoinAddress) return [];

  const response = await fetch(
    `https://blockstream.info/api/address/${encodeURIComponent(bitcoinAddress)}/txs`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Blockstream API error ${response.status}: ${text}`);
  }

  const txs = (await response.json()) as BlockstreamTx[];

  return txs
    .map((tx) => {
      const net = netValueForBitcoinAddress(tx, bitcoinAddress);
      const direction: ActivityItem['direction'] =
        net > 0 ? 'incoming' : net < 0 ? 'outgoing' : 'neutral';
      const sign = net > 0 ? '+' : net < 0 ? '-' : '';
      const timestampSeconds = tx.status.block_time ?? 0;

      return {
        id: tx.txid,
        chain: 'bitcoin',
        title:
          direction === 'incoming'
            ? 'Received BTC'
            : direction === 'outgoing'
            ? 'Sent BTC'
            : 'Bitcoin transfer',
        subtitle: tx.status.confirmed ? 'Bitcoin' : 'Bitcoin · Pending',
        amountText: `${sign}${satoshisToBTCString(Math.abs(net))} BTC`,
        fiatText: null,
        timestamp: new Date(timestampSeconds * 1000).toISOString(),
        txHash: tx.txid,
        status: tx.status.confirmed ? 'confirmed' : 'pending',
        direction,
      };
    })
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return json(res, 401, { error: 'Missing bearer token' });
    }

    const bitcoinAddress =
      typeof req.query.bitcoinAddress === 'string' ? req.query.bitcoinAddress : undefined;

    const privyUserId = await getCurrentPrivyUserId(accessToken);
    const wallets = await getWalletsForUser(privyUserId);

    const evmWallet = pickWallet(wallets, 'ethereum');
    const solanaWallet = pickWallet(wallets, 'solana');

    const [baseTxs, solTxs, btcTxs] = await Promise.all([
      evmWallet ? getPrivyTransactions(evmWallet.id, 'base') : Promise.resolve([]),
      solanaWallet ? getPrivyTransactions(solanaWallet.id, 'solana') : Promise.resolve([]),
      getBitcoinActivity(bitcoinAddress),
    ]);

    const items: ActivityItem[] = [
      ...baseTxs.map((tx) => mapPrivyTransaction(tx, 'base')).filter(Boolean) as ActivityItem[],
      ...solTxs.map((tx) => mapPrivyTransaction(tx, 'solana')).filter(Boolean) as ActivityItem[],
      ...btcTxs,
    ].sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));

    return json(res, 200, { items });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json(res, 500, {
      error: 'Failed to load activity',
      details: message,
    });
  }
}
