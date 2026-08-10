import { createHash } from 'node:crypto';
import { checkRateLimit } from '@vercel/firewall';

export function hashLicenseKey(licenseKey) {
  return createHash('sha256').update(String(licenseKey || ''), 'utf8').digest('hex');
}

// Per-IP limiting is enforced by the Vercel Firewall path rule. This second,
// programmatic bucket prevents a key from being sprayed across many IPs. Only
// the SHA-256 digest reaches the rate-limit service.
export async function enforceHashedKeyRateLimit(res, licenseKey) {
  if (!process.env.VERCEL) return true;
  try {
    const { rateLimited } = await checkRateLimit('pass-license-key', {
      rateLimitKey: hashLicenseKey(licenseKey)
    });
    if (!rateLimited) return true;
    res.setHeader('Retry-After', '60');
    res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many attempts. Try again later.' });
    return false;
  } catch {
    // The production rule is part of the deployment gate. Fail closed if its
    // service is unavailable instead of silently removing abuse protection.
    res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Service is temporarily unavailable.' });
    return false;
  }
}
