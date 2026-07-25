import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { SignJWT } from 'jose';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[bitcoin/prepare] module loaded');

// This route only ever builds an *unsigned* PSBT. Signing happens on the
// user's device via the Privy iOS SDK's `signTransaction({ psbt })`
// (self-custodial wallet -- the backend never touches the private key,
// same model as the Solana and EVM transfer flows).

const NETWORK = btc.NETWORK;
const MEMPOOL_API_BASE = 'https://mempool.space/api';
const DUST_THRESHOLD_SATS = 546n;

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    response: error?.response ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[bitcoin/prepare] ${step}`, JSON.stringify(extra));
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
  return { userId: claims?.userId ?? null };
}

/// Same wallet lookup as wallets/bitcoin.js -- picks the most recently
/// created bitcoin-segwit wallet for this user.
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
  logStep('findBitcoinWalletForUser:rest_response', { status: response.status, ok: response.ok });

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
  if (wallets.length === 0) return null;
  const sorted = [...wallets].sort(
    (a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0)
  );
  return sorted[0];
}

async function fetchUtxos(address) {
  const response = await fetch(`${MEMPOOL_API_BASE}/address/${address}/utxo`);
  if (!response.ok) {
    const error = new Error(`Failed to fetch UTXOs (status ${response.status})`);
    error.status = 502;
    throw error;
  }
  const utxos = await response.json();
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
  return fees.halfHourFee ?? fees.hourFee ?? 5;
}

function estimateVBytes(numInputs, numOutputs) {
  return Math.ceil(10.5 + numInputs * 68 + numOutputs * 31);
}

function selectUtxos(utxos, amountSats, feeRateSatsPerVByte) {
  const selected = [];
  let total = 0n;

  for (const utxo of utxos) {
    selected.push(utxo);
    total += BigInt(utxo.value);

    const vBytes = estimateVBytes(selected.length, 2);
    const fee = BigInt(Math.ceil(vBytes * feeRateSatsPerVByte));

    if (total >= amountSats + fee) {
      return { selected, fee, total };
    }
  }

  const error = new Error('Insufficient Bitcoin balance to cover amount + network fee');
  error.status = 400;
  throw error;
}

async function buildUnsignedTransaction({ wallet, toAddress, amountSats }) {
  const pubkeyBytes = hex.decode(wallet.public_key);
  const ownScript = btc.p2wpkh(pubkeyBytes, NETWORK);

  if (ownScript.address !== wallet.address) {
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

  return { tx, inputCount: selected.length, fee };
}

/// Same reasoning as the Solana transferId: Vercel functions are
/// stateless, so everything /submit needs to verify + rebuild context is
/// embedded directly in this signed JWT rather than relying on shared
/// storage between requests. 60s expiry mirrors the Solana flow too.
async function signTransferToken(payload) {
  const secret = new TextEncoder().encode(env.appSecret);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secret);
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

    const trimmedToAddress = toAddress.trim();

    const { tx, inputCount, fee } = await buildUnsignedTransaction({
      wallet,
      toAddress: trimmedToAddress,
      amountSats: amount
    });

    const psbtHex = hex.encode(tx.toPSBT());

    const transferId = await signTransferToken({
      sub: userId,
      walletId: wallet.id,
      walletAddress: wallet.address,
      toAddress: trimmedToAddress,
      amountSats: amount.toString(),
      fee: fee.toString()
    });

    logStep('handler:psbt_built', { userId, inputCount, fee: fee.toString() });

    return res.status(200).json({ transferId, psbtHex, fee: fee.toString() });
  } catch (error) {
    const serialized = safeSerializeError(error);
    console.error('[bitcoin/prepare] handler:error', JSON.stringify(serialized));
    return res.status(error?.status || 500).json({
      error: error?.message || 'Failed to prepare Bitcoin transfer',
      details: serialized
    });
  }
}
