import { env } from '../config/env.js';

const PRIVY_BASE_URL = 'https://api.privy.io';

function basicAuthHeader() {
  const token = Buffer.from(`${env.privyAppId}:${env.privyAppSecret}`).toString('base64');
  return `Basic ${token}`;
}

export async function privyFetch(path, options = {}) {
  const response = await fetch(`${PRIVY_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: basicAuthHeader(),
      'privy-app-id': env.privyAppId,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Privy API error: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
