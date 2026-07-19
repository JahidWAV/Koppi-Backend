import { PrivyClient } from '@privy-io/node';
import { importSPKI, jwtVerify } from 'jose';
import { env } from './env.js';

export const privy = new PrivyClient(
  env.appId,
  env.appSecret,
  {
    walletApi: {
      authorizationPrivateKey: env.authorizationPrivateKey
    }
  }
);

export function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function getVerificationKey() {
  return env.jwtVerificationKey.replace(/\\n/g, '\n');
}

export async function verifyPrivyAccessToken(accessToken) {
  const verificationKey = await importSPKI(getVerificationKey(), 'ES256');

  const { payload } = await jwtVerify(accessToken, verificationKey, {
    issuer: 'privy.io',
    audience: env.appId
  });

  return {
    appId: payload.aud,
    userId: payload.sub,
    issuer: payload.iss,
    issuedAt: payload.iat,
    expiration: payload.exp,
    sessionId: payload.sid,
    rawClaims: payload
  };
}
