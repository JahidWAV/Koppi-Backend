import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[bitcoin/send] module loaded');

// IMPORTANT: set this to btc.TEST_NETWORK if this wallet is meant to run
// on Bitcoin testnet rather than mainnet. Everything below (UTXO source,
// broadcast endpoint) also needs to switch to mempool.space's
// /testnet/api base if you flip this.
const NETWORK = btc.NETWORK;
const MEMPOOL_API_BASE = 'https://mempool.space/api';

// Standard dust threshold for a P2WPKH output. Below this, a change
// output isn't economical to create — it's cheaper to let it go to fees.
const DUST_THRESHOLD_SATS = 546n;

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    code: error?.code ?? null,
    stack: error?.stack ?? null,
    response: error?.response ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[bitcoin/send] ${step}`, JSON.stringify(extra));
}

function getPrivyBasicAuthHeader() {
  const credentials = Buffer.from(`${env.appId}:${env.appSecret}`).toString('base64');
  return `Basic ${credentials}`;
}

async function verifyAccessToken(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error('Missing bearer token');
    error.status = 401;
    throw error;
  }
  const claims = await verifyPrivyAccessToken(token);
  return { userId: claims?.userId ?? null, claims };
}

/// Mirrors `listBitcoinWalletsForUser` from wallets/bitcoin.js — this
/// route assumes the wallet already exists (created via that endpoint) and
/// does not create one.
async function findBitcoinWalletForUser(userId) {
  const url = new URL('https://api.privy.io/v1/wallets');
  url.searchParams.set('user_id', userId);
  url.searchParams.set('chain_type', 'bitcoin-segwit');
  url.searchParams.set('limit', '100');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'privy-app-id': env.appId
    }
  });

  const responseText = await response.text();
  logStep('findBitcoinWalletForUser:rest_response', {
    status: response.status,
    ok: response.ok
  });

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Privy wallet lookup failed with status ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  const wallets = Array.isArray(parsed?.data) ? parsed.data : [];
  return wallets[0] ?? null;
}

async function fetchUtxos(address) {
  const response = await fetch(`${MEMPOOL_API_BASE}/address/${address}/utxo`);
  if (!response.ok) {
    const error = new Error(`Failed to fetch UTXOs (status ${response.status})`);
    error.status = 502;
    throw error;
  }
  const utxos = await response.json();
  // Largest-first: minimizes input count (and therefore fee) for a
  // single-recipient payment like this one.
  return utxos.sort((a, b) => b.value - a.value);
}

async function fetchFeeRateSatsPerVByte() {
  const response = await fetch(`${MEMPOOL_API_BASE}/v1/fees/recommended`);
  if (!response.ok) {
    const error = new Error(`Failed to fetch fee estimate (status ${response.status})`);
    error.status = 502;
    throw error;
  }
  const fees = await response.json();
  // halfHourFee is a reasonable default for a wallet send flow — fast
  // enough without paying the "next block" premium.
  return fees.halfHourFee ?? fees.hourFee ?? 5;
}

/// Standard vByte approximation for an all-P2WPKH transaction:
/// ~10.5 base + 68 per input + 31 per output. Good enough for fee
/// estimation purposes; Bitcoin doesn't require exact fees, only "enough".
function estimateVBytes(numInputs, numOutputs) {
  return Math.ceil(10.5 + numInputs * 68 + numOutputs * 31);
}

/// Greedily selects UTXOs (largest-first) until the total covers the send
/// amount plus the fee for that specific input count — recomputing the fee
/// as more inputs are added, since more inputs means a bigger (costlier)
/// transaction. Assumes a change output is included in the estimate; if
/// there ends up being no change, the tx is very slightly overpaying,
/// which is harmless.
function selectUtxos(utxos, amountSats, feeRateSatsPerVByte) {
  const selected = [];
  let total = 0n;

  for (const utxo of utxos) {
    selected.push(utxo);
    total += BigInt(utxo.value);

    const vBytes = estimateVBytes(selected.length, 2); // recipient + change
    const fee = BigInt(Math.ceil(vBytes * feeRateSatsPerVByte));

    if (total >= amountSats + fee) {
      return { selected, fee, total };
    }
  }

  const error = new Error('Insufficient Bitcoin balance to cover amount + network fee');
  error.status = 400;
  throw error;
}

async function buildUnsignedPsbt({ wallet, toAddress, amountSats }) {
  const pubkeyBytes = hex.decode(wallet.public_key);
  const ownScript = btc.p2wpkh(pubkeyBytes, NETWORK);

  if (ownScript.address !== wallet.address) {
    // Sanity check — if this ever fires, the wallet's stored public_key
    // doesn't match its address, and continuing would risk building a
    // transaction that can't actually be signed correctly.
    const error = new Error('Wallet public key does not match wallet address');
    error.status = 500;
    throw error;
  }

  const utxos = await fetchUtxos(wallet.address);
  if (utxos.length === 0) {
    const error = new Error('No spendable UTXOs found for this wallet');
    error.status = 400;
    throw error;
  }

  const feeRate = await fetchFeeRateSatsPerVByte();
  const { selected, fee, total } = selectUtxos(utxos, amountSats, feeRate);

  const tx = new btc.Transaction();

  for (const utxo of selected) {
    tx.addInput({
      txid: hex.decode(utxo.txid),
      index: utxo.vout,
      witnessUtxo: {
        script: ownScript.script,
        amount: BigInt(utxo.value)
      }
    });
  }

  tx.addOutputAddress(toAddress, amountSats, NETWORK);

  const change = total - amountSats - fee;
  if (change >= DUST_THRESHOLD_SATS) {
    tx.addOutputAddress(wallet.address, change, NETWORK);
  }

  return { psbtHex: hex.encode(tx.toPSBT()), inputCount: selected.length, fee };
}

async function signWithPrivy(walletId, psbtHex) {
  const response = await fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'Content-Type': 'application/json',
      'privy-app-id': env.appId
    },
    body: JSON.stringify({
      method: 'signTransaction',
      chain_type: 'bitcoin-segwit',
      params: { psbt: psbtHex }
    })
  });

  const responseText = await response.text();
  logStep('signWithPrivy:rest_response', { status: response.status, ok: response.ok });

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Privy signTransaction failed with status ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  const signedTransaction = parsed?.data?.signedTransaction;
  if (!signedTransaction) {
    const error = new Error('Privy response did not include a signedTransaction');
    error.status = 502;
    error.response = parsed;
    throw error;
  }

  return signedTransaction;
}

async function broadcastRawTransaction(rawTxHex) {
  const response = await fetch(`${MEMPOOL_API_BASE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: rawTxHex
  });

  const responseText = await response.text();
  logStep('broadcastRawTransaction:response', { status: response.status, ok: response.ok });

  if (!response.ok) {
    const error = new Error(`Broadcast failed: ${responseText}`);
    error.status = 502;
    error.response = responseText;
    throw error;
  }

  // mempool.space's /tx endpoint returns the raw txid as plain text.
  return responseText.trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = await verifyAccessToken(req);

    const { toAddress, amountSats } = req.body ?? {};
    if (typeof toAddress !== 'string' || !toAddress.trim()) {
      return res.status(400).json({ error: 'toAddress is required' });
    }
    if (typeof amountSats !== 'string' || !/^\d+$/.test(amountSats)) {
      return res.status(400).json({ error: 'amountSats must be a numeric string' });
    }

    const amount = BigInt(amountSats);
    if (amount <= 0n) {
      return res.status(400).json({ error: 'amountSats must be greater than zero' });
    }

    const wallet = await findBitcoinWalletForUser(userId);
    if (!wallet?.address || !wallet?.public_key) {
      const error = new Error('No Bitcoin wallet found for this user');
      error.status = 404;
      throw error;
    }

    const { psbtHex, inputCount, fee } = await buildUnsignedPsbt({
      wallet,
      toAddress: toAddress.trim(),
      amountSats: amount
    });

    logStep('handler:psbt_built', { userId, inputCount, fee: fee.toString() });

    const signedTxHex = await signWithPrivy(wallet.id, psbtHex);
    const txId = await broadcastRawTransaction(signedTxHex);

    logStep('handler:success', { userId, txId });

    return res.status(200).json({ txId });
  } catch (error) {
    const serialized = safeSerializeError(error);
    console.error('[bitcoin/send] handler:error', JSON.stringify(serialized));
    return res.status(error?.status || 500).json({
      error: error?.message || 'Failed to send Bitcoin transaction',
      details: serialized
    });
  }
}
