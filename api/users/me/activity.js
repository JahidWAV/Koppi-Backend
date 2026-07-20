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

async function fetchPrivyWalletTransactions(walletId) {
  if (!walletId) return [];

  const appId = requireEnv('PRIVY_APP_ID', PRIVY_APP_ID);
  const appSecret = requireEnv('PRIVY_APP_SECRET', PRIVY_APP_SECRET);

  const url = `${PRIVY_BASE_URL}/v1/wallets/${walletId}/transactions`;

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
    console.error('Privy transactions error', response.status, text, { walletId });
    throw new Error(`Failed wallet transactions fetch: ${response.status}`);
  }

  const json = JSON.parse(text);
  return json.data || json.transactions || [];
}

async function fetchBitcoinTransactions(address) {
  if (!address) return [];

  const response = await fetch(`${ESPLORA_BASE_URL}/address/${address}/txs`);
  if (!response.ok) {
    throw new Error(`Failed BTC transactions fetch: ${response.status}`);
  }

  return response.json();
}

function shorten(value, start = 6, end = 4) {
  if (!value || value.length <= start + end) return value || '';
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function normalizePrivyTransaction(tx, chainLabel) {
  const txHash = tx.hash || tx.tx_hash || tx.transaction_hash || tx.id || null;
  const createdAt =
    tx.created_at ||
    tx.timestamp ||
    tx.sent_at ||
    tx.updated_at ||
    new Date().toISOString();

  const status = String(tx.status || 'confirmed').toLowerCase();

  const amount =
    tx.value ||
    tx.amount ||
    tx.display_value ||
    tx.amount_display ||
    '—';

  const asset =
    tx.asset ||
    tx.symbol ||
    tx.asset_symbol ||
    '';

  const direction = String(tx.direction || 'neutral').toLowerCase();

  return {
    id: `${chainLabel.lower}-${txHash || createdAt}`,
    chain: chainLabel.name,
    title: `${chainLabel.name} transfer`,
    subtitle: status === 'confirmed' ? 'Confirmed' : 'Pending',
    amountText: asset ? `${amount} ${asset}` : String(amount),
    fiatText: tx.fiat_value_usd ? `$${tx.fiat_value_usd}` : null,
    timestamp: createdAt,
    txHash,
    status,
    direction: ['incoming', 'outgoing'].includes(direction) ? direction : 'neutral',
  };
}

function netBitcoinValueForAddress(tx, address) {
  const received = (tx.vout || [])
    .filter((v) => v.scriptpubkey_address === address)
    .reduce((sum, v) => sum + Number(v.value || 0), 0);

  const spent = (tx.vin || [])
    .filter((v) => v.prevout?.scriptpubkey_address === address)
    .reduce((sum, v) => sum + Number(v.prevout?.value || 0), 0);

  return received - spent;
}

function normalizeBitcoinTransaction(tx, address) {
  const sats = netBitcoinValueForAddress(tx, address);
  const btc = sats / 100000000;
  const direction = sats > 0 ? 'incoming' : sats < 0 ? 'outgoing' : 'neutral';

  return {
    id: `btc-${tx.txid}`,
    chain: 'Bitcoin',
    title: 'Bitcoin transfer',
    subtitle: tx.status?.confirmed ? 'Confirmed' : 'Pending',
    amountText: `${btc > 0 ? '+' : ''}${btc.toFixed(8)} BTC`,
    fiatText: null,
    timestamp: tx.status?.block_time
      ? new Date(tx.status.block_time * 1000).toISOString()
      : new Date().toISOString(),
    txHash: tx.txid,
    status: tx.status?.confirmed ? 'confirmed' : 'pending',
    direction,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const claims = await verifyPrivyAccessToken(token);

    const {
      evmWalletId,
      solanaWalletId,
      bitcoinAddress,
    } = req.query;

    const [evmTxs, solanaTxs, bitcoinTxs] = await Promise.all([
      evmWalletId ? fetchPrivyWalletTransactions(evmWalletId) : Promise.resolve([]),
      solanaWalletId ? fetchPrivyWalletTransactions(solanaWalletId) : Promise.resolve([]),
      bitcoinAddress ? fetchBitcoinTransactions(bitcoinAddress) : Promise.resolve([]),
    ]);

    const items = [
      ...evmTxs.map((tx) => normalizePrivyTransaction(tx, { name: 'EVM', lower: 'evm' })),
      ...solanaTxs.map((tx) => normalizePrivyTransaction(tx, { name: 'Solana', lower: 'solana' })),
      ...bitcoinTxs.map((tx) => normalizeBitcoinTransaction(tx, bitcoinAddress)),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return res.status(200).json({
      ok: true,
      userId: claims.sub || null,
      items,
    });
  } catch (error) {
    console.error('GET /api/users/me/activity error', error);

    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to fetch activity',
    });
  }
}
