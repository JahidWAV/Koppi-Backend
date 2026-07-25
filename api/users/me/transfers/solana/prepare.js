import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl
} from '@solana/web3.js';
import { SignJWT } from 'jose';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[solana/prepare] module loaded');

// Same pattern as bitcoin.js: everything self-contained in the handler
// file, no shared Privy REST client.

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
  console.log(`[solana/prepare] ${step}`, JSON.stringify(extra));
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

/// Looks up the user's Solana wallet (created earlier during
/// `loadWallets` on the client — this route assumes it already exists and
/// does not create one, unlike bitcoin.js).
async function findSolanaWalletForUser(userId) {
  const url = new URL('https://api.privy.io/v1/wallets');
  url.searchParams.set('user_id', userId);
  url.searchParams.set('chain_type', 'solana');
  url.searchParams.set('limit', '100');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: getPrivyBasicAuthHeader(),
      'privy-app-id': env.appId
    }
  });

  const responseText = await response.text();
  logStep('findSolanaWalletForUser:rest_response', {
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

function getSolanaConnection() {
  // Prefer a dedicated RPC (Helius/QuickNode/etc) via env var in
  // production — the public cluster endpoint is rate-limited and not
  // meant for production traffic.
  const endpoint = env.solanaRpcUrl || clusterApiUrl('mainnet-beta');
  return new Connection(endpoint, 'confirmed');
}

/// Signs a compact JWT that *is* the transferId. Since Vercel serverless
/// functions are stateless (no guarantee `/prepare` and `/submit` hit the
/// same instance, or that any in-memory store survives between calls), the
/// unsigned message + everything `/submit` needs to finish the transfer is
/// embedded directly in this token instead of relying on shared storage.
/// Signed with the existing Privy app secret (already a private value this
/// deployment holds) via HS256, short-lived (5 minutes) to match the
/// device-side assumption that a prepared transfer expires quickly.
async function signTransferToken(payload) {
  const secret = new TextEncoder().encode(env.appSecret);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = await verifyAccessToken(req);

    const { toAddress, amountLamports } = req.body ?? {};
    if (typeof toAddress !== 'string' || !toAddress.trim()) {
      return res.status(400).json({ error: 'toAddress is required' });
    }
    if (typeof amountLamports !== 'string' || !/^\d+$/.test(amountLamports)) {
      return res.status(400).json({ error: 'amountLamports must be a numeric string' });
    }

    let recipientPubkey;
    try {
      recipientPubkey = new PublicKey(toAddress.trim());
    } catch {
      return res.status(400).json({ error: 'toAddress is not a valid Solana address' });
    }

    const wallet = await findSolanaWalletForUser(userId);
    if (!wallet?.address) {
      const error = new Error('No Solana wallet found for this user');
      error.status = 404;
      throw error;
    }

    const fromPubkey = new PublicKey(wallet.address);
    const connection = getSolanaConnection();

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
      feePayer: fromPubkey,
      recentBlockhash: blockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: recipientPubkey,
        lamports: BigInt(amountLamports)
      })
    );

    // This is exactly what the device needs to sign: the serialized
    // *message* (not the full transaction — there's nothing to sign there
    // yet since it carries no signatures). `requireAllSignatures: false`
    // and `verifySignatures: false` are required here since the
    // transaction is, by definition, unsigned at this point.
    const messageBytes = transaction.serializeMessage();
    const messageBase64 = messageBytes.toString('base64');

    const transferId = await signTransferToken({
      sub: userId,
      walletAddress: wallet.address,
      toAddress: recipientPubkey.toBase58(),
      amountLamports,
      blockhash,
      lastValidBlockHeight,
      messageBase64
    });

    logStep('handler:success', { userId, walletAddress: wallet.address });

    return res.status(200).json({ transferId, messageBase64 });
  } catch (error) {
    const serialized = safeSerializeError(error);
    console.error('[solana/prepare] handler:error', JSON.stringify(serialized));
    return res.status(error?.status || 500).json({
      error: error?.message || 'Failed to prepare Solana transfer',
      details: serialized
    });
  }
}
