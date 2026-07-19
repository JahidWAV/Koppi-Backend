import { privy, getBearerToken } from '../../../../lib/privy.js';

async function verifyAccessToken(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error('Missing bearer token');
    error.status = 401;
    throw error;
  }

  const claims = await privy.utils().auth().verifyAccessToken({
    access_token: token
  });

  return {
    token,
    userId: claims.userId
  };
}

async function createSegwitWallet(userId) {
  const wallet = await privy.walletApi.createWallet({
    chain_type: 'bitcoin-segwit',
    owner: {
      user_id: userId
    }
  });

  return wallet;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = await verifyAccessToken(req);
    const wallet = await createSegwitWallet(userId);

    return res.status(200).json({
      ok: true,
      walletId: wallet.id,
      address: wallet.address,
      publicKey: wallet.public_key,
      chainType: wallet.chain_type
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || 'Unexpected server error'
    });
  }
}
