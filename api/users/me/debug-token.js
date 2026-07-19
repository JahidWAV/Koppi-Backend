import { getBearerToken, verifyPrivyAccessToken } from '../../../lib/privy.js';

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

    return res.status(200).json({
      ok: true,
      claims
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Token verification failed',
      message: error.message,
      name: error.name
    });
  }
}
