import * as btc from '@scure/btc-signer';
import { OutScript } from '@scure/btc-signer/payment';
import { hex } from '@scure/base';
import { jwtVerify } from 'jose';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[bitcoin/submit] module loaded');

const NETWORK = btc.NETWORK;
const MEMPOOL_API_BASE = 'https://mempool.space/api';

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
    response: error?.response ?? null
  };
}

function logStep(step, extra = {}) {
  console.log(`[bitcoin/submit] ${step}`, JSON.stringify(extra));
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

/// Reads an output's address+amount, working whether the transaction has
/// been finalized yet or not (used for the sanity check against what
/// prepare.js actually built).
function describeOutput(tx, index) {
  const output = tx.getOutput(index);
  return {
    address: btc.Address(NETWORK).encode(OutScript.decode(output.script)),
    amount: output.amount
  };
}

/// The client returns a *signed* PSBT (partialSig filled in per input by
/// the Privy SDK), not necessarily a finalized one. finalize() throws if
/// called on an already-finalized input ("Not enough partial sign"), so
/// only finalize if it hasn't happened yet.
function finalizeIfNeeded(tx) {
  const alreadyFinalized = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i)).every(
    (input) => !!input.finalScriptWitness || !!input.finalScriptSig
  );
  if (!alreadyFinalized) {
    tx.finalize();
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

  return responseText.trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = await verifyAccessToken(req);

    const { transferId, signedPsbtHex } = req.body ?? {};
    if (typeof transferId !== 'string' || !transferId) {
      return res.status(400).json({ error: 'transferId is required' });
    }
    if (typeof signedPsbtHex !== 'string' || !signedPsbtHex) {
      return res.status(400).json({ error: 'signedPsbtHex is required' });
    }

    const prepared = await verifyTransferToken(transferId, userId);

    let tx;
    try {
      tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex));
    } catch (parseError) {
      const error = new Error('signedPsbtHex is not a valid PSBT');
      error.status = 400;
      error.cause = parseError;
      throw error;
    }

    // Sanity check: the signed PSBT the client sent back must pay the same
    // recipient the same amount that prepare.js actually built. This
    // can't be a security hole either way (it's the user's own wallet),
    // but it catches integration bugs early with a clear error instead of
    // silently broadcasting something unexpected.
    const outputs = Array.from({ length: tx.outputsLength }, (_, i) => describeOutput(tx, i));
    const matchesRecipient = outputs.some(
      (output) =>
        output.address === prepared.toAddress && output.amount === BigInt(prepared.amountSats)
    );
    if (!matchesRecipient) {
      const error = new Error('Signed transaction does not match the prepared transfer');
      error.status = 400;
      error.response = { outputs: outputs.map((o) => ({ address: o.address, amount: o.amount.toString() })) };
      throw error;
    }

    finalizeIfNeeded(tx);

    const signedTxHex = tx.hex;
    const txId = await broadcastRawTransaction(signedTxHex);

    logStep('handler:success', { userId, txId });

    return res.status(200).json({ txId });
  } catch (error) {
    const serialized = safeSerializeError(error);
    console.error('[bitcoin/submit] handler:error', JSON.stringify(serialized));
    return res.status(error?.status || 500).json({
      error: error?.message || 'Failed to submit Bitcoin transfer',
      details: serialized
    });
  }
}
