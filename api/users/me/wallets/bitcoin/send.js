import crypto from 'node:crypto';
import canonicalize from 'canonicalize';
import * as btc from '@scure/btc-signer';
import { OutScript } from '@scure/btc-signer/payment';
import { getInputType, getPrevOut } from '@scure/btc-signer/transaction';
import { concatBytes } from '@scure/btc-signer/utils';
import secp256k1 from 'secp256k1';
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

/// This wallet has an owner (the "IOS" authorization key), so any action
/// that mutates or uses it -- raw_sign included -- must carry a
/// `privy-authorization-signature` header, or Privy rejects it with 401.
/// See docs.privy.io/api-reference/authorization-signatures.
///
/// The stored key material comes in as "wallet-auth:<base64 pkcs8>" --
/// stripping the prefix and wrapping it in standard PEM armor gives Node's
/// native `crypto` module something it can import directly, no extra
/// crypto library needed.
function getPrivyAuthorizationPrivateKey() {
  const raw = env.privyAuthorizationKey;
  if (!raw) {
    const error = new Error(
      'Missing Privy authorization private key (env.privyAuthorizationKey / PRIVY_AUTHORIZATION_KEY)'
    );
    error.status = 500;
    throw error;
  }
  const base64Body = raw.replace(/^wallet-auth:/, '');
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64Body}\n-----END PRIVATE KEY-----`;
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

/// Builds the `privy-authorization-signature` header value for a POST
/// request. The payload shape and the RFC 8785 (JCS) canonicalization are
/// both mandated by Privy -- the signature is over the canonical JSON
/// string of { version, method, url, body, headers }, where `headers` here
/// is only the subset of headers Privy tells you to include (privy-app-id,
/// plus privy-request-expiry if you're sending one), not the full request.
function buildPrivyAuthorizationSignature({ method, url, body, requestExpiry }) {
  const headers = { 'privy-app-id': env.appId };
  if (requestExpiry) headers['privy-request-expiry'] = requestExpiry;

  const payload = { version: 1, method, url, body, headers };
  const canonical = canonicalize(payload);

  const privateKey = getPrivyAuthorizationPrivateKey();
  const signature = crypto.sign('sha256', Buffer.from(canonical), privateKey);
  return signature.toString('base64');
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

/// Builds the unsigned Transaction object (kept in memory, not round-
/// tripped through a PSBT — Privy signs each input's hash directly via
/// raw_sign, so there's no need to hand the PSBT to anything external).
async function buildUnsignedTransaction({ wallet, toAddress, amountSats }) {
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

  return { tx, inputCount: selected.length, fee, pubkeyBytes };
}

async function rawSignWithPrivy(walletId, hashHex) {
  const url = `https://api.privy.io/v1/wallets/${walletId}/raw_sign`;
  const body = { params: { hash: hashHex } };
  // 60s is plenty for this single outbound call; short-lived on purpose so
  // a captured/replayed request can't be reused later.
  const requestExpiry = String(Date.now() + 60_000);

  const authorizationSignature = buildPrivyAuthorizationSignature({
    method: 'POST',
    url,
    body,
    requestExpiry
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'Content-Type': 'application/json',
      'privy-app-id': env.appId,
      'privy-request-expiry': requestExpiry,
      'privy-authorization-signature': authorizationSignature
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  logStep('rawSignWithPrivy:rest_response', { status: response.status, ok: response.ok });

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Privy raw_sign failed with status ${response.status}`);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  const signature = parsed?.data?.signature;
  if (!signature) {
    const error = new Error('Privy raw_sign response did not include a signature');
    error.status = 502;
    error.response = parsed;
    throw error;
  }

  return signature;
}

/// Signs every input of `tx` via Privy's raw_sign endpoint, one at a time.
/// This is the Bitcoin-segwit equivalent of what `signTransaction` does in
/// one call for Solana: Privy has no whole-PSBT signing route for Bitcoin
/// at the REST level, only per-input raw hash signing (see
/// docs.privy.io/wallets/using-wallets/bitcoin/sign-transaction-inputs).
/// For a P2WPKH input, BIP143's sighash preimage uses the *legacy* P2PKH
/// script as its "scriptCode" (not the P2WPKH script itself) -- that's
/// what the wpkh -> pkh OutScript conversion below is for.
async function signAllInputsWithPrivy(tx, walletId, pubkeyBuffer) {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const inputType = getInputType(input, tx.opts.allowLegacyWitnessUtxo);
    const prevOut = getPrevOut(input);

    let script = inputType.lastScript;
    if (inputType.last.type === 'wpkh') {
      script = OutScript.encode({ type: 'pkh', hash: inputType.last.hash });
    }

    const sighash = tx.preimageWitnessV0(i, script, inputType.sighash, prevOut.amount);

    const signatureHex = await rawSignWithPrivy(walletId, `0x${hex.encode(sighash)}`);
    const signatureBytes = Buffer.from(signatureHex.replace(/^0x/, ''), 'hex');
    // Privy's raw_sign is documented to return a hex signature but doesn't
    // pin down compact vs. DER encoding. A raw secp256k1 ECDSA signature
    // is always exactly 64 bytes (r || s); anything else is assumed to be
    // DER and gets parsed down to that same 64-byte compact form, which is
    // what partialSig expects here (@scure/btc-signer DER-encodes it
    // internally at finalize time).
    const compactSig = signatureBytes.length === 64
      ? signatureBytes
      : secp256k1.signatureImport(signatureBytes);

    tx.updateInput(
      i,
      {
        partialSig: [[pubkeyBuffer, concatBytes(compactSig, new Uint8Array([inputType.sighash]))]]
      },
      true
    );
  }
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

    const { tx, inputCount, fee, pubkeyBytes } = await buildUnsignedTransaction({
      wallet,
      toAddress: toAddress.trim(),
      amountSats: amount
    });

    logStep('handler:transaction_built', { userId, inputCount, fee: fee.toString() });

    await signAllInputsWithPrivy(tx, wallet.id, Buffer.from(pubkeyBytes));

    // finalize() re-validates every signature against its input script and
    // throws if any of them don't actually verify -- our safety net in
    // case the raw_sign signature format ever doesn't line up with what
    // partialSig expects.
    tx.finalize();

    const signedTxHex = tx.hex;
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
