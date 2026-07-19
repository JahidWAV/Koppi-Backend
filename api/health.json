import { sendJson } from '../lib/json.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 200, {
    ok: true,
    service: 'koppi-backend'
  });
}
