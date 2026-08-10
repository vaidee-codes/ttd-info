import { createPrivateKey, createPublicKey, createSign, createVerify, randomUUID } from 'node:crypto';

const ISSUER = 'https://ttd-info.vercel.app';
const AUDIENCE = 'ttd-autofill-extension';
const KEY_ID = 'ttdaf-es256-2026-08-r3';
const TOKEN_SECONDS = 60 * 60;
let privateKey;
let publicKey;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signingKey() {
  if (privateKey) return privateKey;
  const configured = String(process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY || '').trim();
  if (!configured) throw new Error('TTDAF_ENTITLEMENT_PRIVATE_KEY is not configured');
  if (configured.startsWith('{')) {
    privateKey = createPrivateKey({ key: JSON.parse(configured), format: 'jwk' });
  } else {
    const pem = configured.includes('BEGIN PRIVATE KEY')
      ? configured.replace(/\\n/g, '\n')
      : Buffer.from(configured, 'base64').toString('utf8');
    privateKey = createPrivateKey(pem);
  }
  publicKey = createPublicKey(privateKey);
  return privateKey;
}

function verificationKey() {
  if (!publicKey) signingKey();
  return publicKey;
}

export function issueEntitlement({ productId, licenseKeyId, installationUuid, activationInstanceId, providerExpiry }, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const providerExpirySeconds = providerExpiry ? Math.floor(Date.parse(providerExpiry) / 1000) : null;
  const expiresAt = providerExpirySeconds
    ? Math.min(nowSeconds + TOKEN_SECONDS, providerExpirySeconds)
    : nowSeconds + TOKEN_SECONDS;
  if (expiresAt <= nowSeconds) throw new Error('Provider licence has expired');

  const header = { alg: 'ES256', typ: 'JWT', kid: KEY_ID };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: nowSeconds,
    exp: expiresAt,
    jti: randomUUID(),
    product_id: productId,
    license_key_id: licenseKeyId,
    installation_uuid: installationUuid,
    activation_instance_id: activationInstanceId,
    provider_expiry: providerExpiry || null
  };
  const input = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const signature = signer.sign({ key: signingKey(), dsaEncoding: 'ieee-p1363' });
  return {
    token: input + '.' + base64url(signature),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    claims: payload
  };
}

// Refresh accepts an expired token because a sleeping browser may miss the
// five-minute refresh window. The ES256 signature and all bindings must still
// be valid before Dodo is queried and a replacement token is issued.
export function verifyEntitlement(token, { allowExpired = false, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid entitlement token');
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (header.alg !== 'ES256' || header.kid !== KEY_ID) throw new Error('Invalid entitlement token');
  const verifier = createVerify('SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  verifier.end();
  const valid = verifier.verify(
    { key: verificationKey(), dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url')
  );
  if (!valid || claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw new Error('Invalid entitlement token');
  if (!allowExpired && (!claims.exp || claims.exp <= Math.floor(now / 1000))) throw new Error('Entitlement token expired');
  return claims;
}

export function isInstallationUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
