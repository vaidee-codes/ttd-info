import { createHash } from 'node:crypto';
import { checkRateLimit } from '@vercel/firewall';
import { logRateLimitFailure, logRateLimitTriggered } from './_diagnostics.mjs';

export function hashLicenseKey(licenseKey) {
  return createHash('sha256').update(String(licenseKey || ''), 'utf8').digest('hex');
}

// Per-IP limiting is enforced by the Vercel Firewall path rule. This separate,
// programmatic bucket prevents a key from being sprayed across many IPs. Only
// the SHA-256 digest reaches the rate-limit service.
export async function enforceHashedKeyRateLimit(req, res, licenseKey) {
  if (!process.env.VERCEL) return true;
  try {
    const { rateLimited, error } = await checkRateLimit('pass-license-key', {
      rateLimitKey: hashLicenseKey(licenseKey),
      headers: req && req.headers
    });
    if (error === 'not-found') {
      // @vercel/firewall otherwise treats a missing rule as allowed. The rule
      // is a production security dependency, so absence must fail closed.
      logRateLimitFailure('not_configured');
      res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Service is temporarily unavailable.' });
      return false;
    }
    if (!rateLimited) return true;
    logRateLimitTriggered(licenseKey);
    res.setHeader('Retry-After', '60');
    res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many attempts. Try again later.' });
    return false;
  } catch (error) {
    // The production rule is part of the deployment gate. Fail closed if its
    // service is unavailable instead of silently removing abuse protection.
    logRateLimitFailure(error && error.name || 'check_failed');
    res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Service is temporarily unavailable.' });
    return false;
  }
}
