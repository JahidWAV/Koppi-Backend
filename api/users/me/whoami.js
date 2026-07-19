import { privy, getBearerToken } from '../../../lib/privy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const claims = await privy.utils().auth().verifyAccessToken({
      access_token: token
    });

    return res.status(200).json({
      ok: true,
      userId: claims.userId
    });
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid token',
      details: error.message
    });
  }
}
