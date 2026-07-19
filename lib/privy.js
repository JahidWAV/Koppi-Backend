import { PrivyClient } from '@privy-io/node';
import { env } from './env.js';

export const privy = new PrivyClient({
  appId: env.appId,
  appSecret: env.appSecret
});

export function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}
