function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export const env = {
  appId: required('PRIVY_APP_ID'),
  appSecret: required('PRIVY_APP_SECRET'),
  jwtVerificationKey: required('PRIVY_JWT_VERIFICATION_KEY')
};
