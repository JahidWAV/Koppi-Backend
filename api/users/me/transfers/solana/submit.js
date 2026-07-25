import crypto from 'node:crypto';
import { base58 } from '@scure/base';
import { jwtVerify } from 'jose';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[solana/submit] module loaded');

// Same reasoning as prepare.js: no @solana/web3.js. `/submit` only needs to
// (1) wrap the device's signature + the message from prepare.js into a
// wire-format transaction, (2) verify that signature, and (3) broadcast it
// over plain JSON-RPC. All of that is doable by hand.

// Fixed 12-byte ASN.1/DER prefix for an Ed25519 SubjectPublicKeyInfo. Lets
// Node's built-in crypto module import a raw 32-byte Ed25519 public key
// without pulling in any signing library.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    response: error?.response ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[solana/submit] ${step}`, JSON.stringify(extra));
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

async function verifyTransferToken(transferId, expectedUserId) {
  const secret = new TextEncoder().encode(env.appSecret);

  let payload;
  try {
    const result = await jwtVerify(transferId, secret);
    payload = result.payload;
  } catch (error) {
    const wrapped = new Error('Transfer expired or invalid — please try again.');
    wrapped.status = 400;
    wrapped.cause = error;
    throw wrapped;
  }

  if (payload.sub !== expectedUserId) {
    const error = new Error('This transfer does not belong to the current user.');
    error.status = 403;
    throw error;
  }

  return payload;
}

function getSolanaRpcEndpoint() {
  return env.solanaRpcUrl || 'https://api.mainnet-beta.solana.com';
}

async function solanaRpc(method, params) {
  const response = await fetch(getSolanaRpcEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });

  const json = await response.json();
  if (json.error) {
    const error = new Error(json.error.message || 'Solana RPC error');
    error.status = 502;
    error.response = json.error;
    throw error;
  }
  return json.result;
}

function decodeBase58Pubkey(address, label) {
  let bytes;
  try {
    bytes = base58.decode(address);
  } catch {
    const error = new Error(`${label} is not valid base58`);
    error.status = 400;
    throw error;
  }
  if (bytes.length !== 32) {
    const error = new Error(`${label} is not a valid Solana address (expected 32 bytes)`);
    error.status = 400;
    throw error;
  }
  return bytes;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function encodeCompactU16(n) {
  const bytes = [];
  let value = n;
  for (;;) {
    const elem = value & 0x7f;
    value >>= 7;
    if (value === 0) {
      bytes.push(elem);
      break;
    }
    bytes.push(elem | 0x80);
  }
  return Uint8Array.from(bytes);
}

function verifyEd25519(messageBytes, signatureBytes, publicKeyBytes) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]);
  const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(messageBytes), keyObject, Buffer.from(signatureBytes));
}

/// Wraps a signed message into the wire format Solana expects: a
/// compact-u16 signature count, the signature(s) themselves, then the
/// message bytes unchanged. This transaction has exactly one required
/// signer (the sender), so there's exactly one signature slot.
function buildSignedTransaction(messageBytes, signatureBytes) {
  return concatBytes(encodeCompactU16(1), signatureBytes, messageBytes);
}

/// Best-effort confirmation via polling `getSignatureStatuses` — the
/// websocket-based `confirmTransaction` from @solana/web3.js isn't an
/// option here (that's the dependency we removed), and isn't necessary:
/// the transaction is already broadcast by the time this runs, so a
/// timeout here just means the client falls back to a balance/activity
/// refresh instead of an instant confirmation.
async function pollForConfirmation(txId, { attempts = 10, delayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const { value } = await solanaRpc('getSignatureStatuses', [[txId]]);
    const status = value?.[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return status;
    }
    if (status?.err) {
      const error = new Error('Transaction landed but failed on-chain');
      error.status = 502;
      error.response = status.err;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = await verifyAccessToken(req);

    const { transferId, signatureBase64 } = req.body ?? {};
    if (typeof transferId !== 'string' || !transferId) {
      return res.status(400).json({ error: 'transferId is required' });
    }
    if (typeof signatureBase64 !== 'string' || !signatureBase64) {
      return res.status(400).json({ error: 'signatureBase64 is required' });
    }

    const prepared = await verifyTransferToken(transferId, userId);

    const messageBytes = Buffer.from(prepared.messageBase64, 'base64');
    const signatureBytes = Buffer.from(signatureBase64, 'base64');

    if (signatureBytes.length !== 64) {
      const error = new Error('signatureBase64 is not a valid 64-byte ed25519 signature');
      error.status = 400;
      throw error;
    }

    const walletBytes = decodeBase58Pubkey(prepared.walletAddress, 'walletAddress');

    if (!verifyEd25519(messageBytes, signatureBytes, walletBytes)) {
      const error = new Error('Signature verification failed for this transaction');
      error.status = 400;
      throw error;
    }

    const rawTransaction = buildSignedTransaction(messageBytes, signatureBytes);
    const rawTransactionBase64 = Buffer.from(rawTransaction).toString('base64');

    const txId = await solanaRpc('sendTransaction', [
      rawTransactionBase64,
      { encoding: 'base64', skipPreflight: false, maxRetries: 3 }
    ]);

    logStep('handler:broadcast_success', { userId, txId });

    try {
      await pollForConfirmation(txId);
    } catch (confirmError) {
      logStep('handler:confirm_timeout_or_error', {
        txId,
        message: confirmError?.message ?? null
      });
    }

    return res.status(200).json({ txId });
  } catch (error) {
    const serialized = safeSerializeError(error);
    console.error('[solana/submit] handler:error', JSON.stringify(serialized));
    return res.status(error?.status || 500).json({
      error: error?.message || 'Failed to submit Solana transfer',
      details: serialized
    });
  }
}
