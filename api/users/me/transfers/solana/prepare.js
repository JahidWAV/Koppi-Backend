import { base58 } from '@scure/base';
import { SignJWT } from 'jose';
import {
  getBearerToken,
  verifyPrivyAccessToken
} from '../../../../../lib/privy.js';
import { env } from '../../../../../lib/env.js';

console.log('[solana/prepare] module loaded');

// Deliberately NOT using @solana/web3.js here: importing it pulls in
// `rpc-websockets`, whose module shape breaks under Vercel's serverless
// bundler ("Class extends value undefined is not a constructor"). All we
// actually need -- a blockhash, a compiled transfer message, and a way to
// broadcast -- is small enough to do by hand against Solana's plain HTTP
// JSON-RPC, with zero risky transitive dependencies.

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

function safeSerializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? null,
    status: error?.status ?? null,
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
  logStep('findSolanaWalletForUser:rest_response', { status: response.status, ok: response.ok });

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

function getSolanaRpcEndpoint() {
  // Prefer a dedicated RPC (Helius/QuickNode/etc) via env var in
  // production -- the public endpoint is rate-limited.
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

/// Solana's "compact-u16" (shortvec) length-prefix encoding. Every count in
/// this file (3 account keys, 1 instruction, 2 instruction accounts, 12
/// bytes of instruction data) is small enough to fit in a single byte, but
/// this is written to be correct for any value.
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

function encodeSystemTransferData(lamports) {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer discriminant
  view.setBigUint64(4, lamports, true);
  return buf;
}

/// Builds a legacy (non-versioned) Solana Message for a single native SOL
/// transfer: `from` is the sole (writable, signer) account, `to` is
/// writable, and the System Program is readonly -- the standard shape for
/// this instruction. Returns the raw message bytes exactly as they need to
/// be signed and later wrapped into a full transaction.
function buildTransferMessage({ fromBytes, toBytes, lamports, blockhashBytes }) {
  const systemProgramBytes = decodeBase58Pubkey(SYSTEM_PROGRAM_ID, 'systemProgram');
  const accountKeys = [fromBytes, toBytes, systemProgramBytes];

  // numRequiredSignatures=1, numReadonlySignedAccounts=0,
  // numReadonlyUnsignedAccounts=1 (the System Program).
  const header = Uint8Array.from([1, 0, 1]);

  const accountKeysSection = concatBytes(encodeCompactU16(accountKeys.length), ...accountKeys);

  const instructionData = encodeSystemTransferData(lamports);
  const compiledInstruction = concatBytes(
    Uint8Array.from([2]), // program_id_index: systemProgram is accountKeys[2]
    encodeCompactU16(2), // 2 accounts referenced by this instruction
    Uint8Array.from([0, 1]), // from=accountKeys[0], to=accountKeys[1]
    encodeCompactU16(instructionData.length),
    instructionData
  );
  const instructionsSection = concatBytes(encodeCompactU16(1), compiledInstruction);

  return concatBytes(header, accountKeysSection, blockhashBytes, instructionsSection);
}

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

    const toBytes = decodeBase58Pubkey(toAddress.trim(), 'toAddress');

    const wallet = await findSolanaWalletForUser(userId);
    if (!wallet?.address) {
      const error = new Error('No Solana wallet found for this user');
      error.status = 404;
      throw error;
    }
    const fromBytes = decodeBase58Pubkey(wallet.address, 'wallet.address');

    const { value } = await solanaRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const { blockhash, lastValidBlockHeight } = value;
    const blockhashBytes = decodeBase58Pubkey(blockhash, 'blockhash');

    const messageBytes = buildTransferMessage({
      fromBytes,
      toBytes,
      lamports: BigInt(amountLamports),
      blockhashBytes
    });
    const messageBase64 = Buffer.from(messageBytes).toString('base64');

    const transferId = await signTransferToken({
      sub: userId,
      walletAddress: wallet.address,
      toAddress: base58.encode(toBytes),
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
