import { createHmac } from 'node:crypto';

const REF_HEX_LENGTH = 20;

// Stable, privacy-safe references let an incident be joined back to a Dodo
// licence or browser installation without placing raw provider IDs in logs.
// Keep the secret in Vercel; changing it intentionally breaks old references.
export function diagnosticRef(kind, value) {
  const secret = String(process.env.TTDAF_LOG_CORRELATION_SECRET || '').trim();
  const cleanKind = String(kind || '').trim();
  const cleanValue = String(value || '').trim();
  if (!secret || !cleanKind || !cleanValue) return null;
  return createHmac('sha256', secret)
    .update(cleanKind)
    .update('\0')
    .update(cleanValue)
    .digest('hex')
    .slice(0, REF_HEX_LENGTH);
}

export function logProviderFailure(operation, error, context = {}) {
  // Never log request bodies, licence keys, customer data, tokens, raw Dodo
  // identifiers, or provider responses. The references below are HMACs.
  console.error(JSON.stringify({
    event: 'provider_failure',
    operation,
    status: Number(error && error.status) || null,
    code: String(error && error.code || '').slice(0, 64) || null,
    license_ref: diagnosticRef('dodo_license_id', context.licenseKeyId),
    instance_ref: diagnosticRef('dodo_instance_id', context.instanceId),
    installation_ref: diagnosticRef('installation_uuid', context.installationUuid),
    correlation_configured: !!String(process.env.TTDAF_LOG_CORRELATION_SECRET || '').trim()
  }));
}

// Every activation attempt logs one non-PII outcome line. Without it the
// production logs cannot say WHY an attempt failed (used slot vs expired key vs
// uncompleted payment), which is exactly what made the "invalid key" reports
// impossible to triage from the server side.
export function logActivationOutcome({
  outcome,
  reason = null,
  licenseKey = null,
  licenseKeyId = null,
  instanceId = null,
  installationUuid = null,
  recovered = false
}) {
  console.log(JSON.stringify({
    event: 'license_activate_outcome',
    outcome: String(outcome || 'unknown').slice(0, 40),
    reason: reason ? String(reason).slice(0, 48) : null,
    recovered: !!recovered,
    license_key_ref: diagnosticRef('dodo_license_key', licenseKey),
    license_ref: diagnosticRef('dodo_license_id', licenseKeyId),
    instance_ref: diagnosticRef('dodo_instance_id', instanceId),
    installation_ref: diagnosticRef('installation_uuid', installationUuid),
    correlation_configured: !!String(process.env.TTDAF_LOG_CORRELATION_SECRET || '').trim()
  }));
}

// Checkout funnel telemetry: distinguishes a purchase that opted into
// automatic activation from one that will need a manual key paste. No
// customer data, no key.
export function logCheckoutCreated({ plan, autoActivate }) {
  console.log(JSON.stringify({
    event: 'checkout_created',
    plan: String(plan || '').slice(0, 8),
    auto_activate: !!autoActivate
  }));
}

export function logCheckoutRejected({ reason, detail = '' }) {
  console.log(JSON.stringify({
    event: 'checkout_rejected',
    reason: String(reason || 'invalid_request').slice(0, 40),
    detail: String(detail || '').slice(0, 60)
  }));
}

export function logRateLimitFailure(reason) {
  console.error(JSON.stringify({
    event: 'rate_limit_unavailable',
    rate_limit_id: 'pass-license-key',
    reason: String(reason || 'unknown').slice(0, 64)
  }));
}

export function logRateLimitTriggered(licenseKey) {
  // A warning is emitted only after the limiter has rejected a request. It is
  // intentionally separate from provider failures so abuse does not inflate
  // 5xx/error alerts, and it never contains the raw licence key or an IP.
  console.warn(JSON.stringify({
    event: 'rate_limit_triggered',
    rate_limit_id: 'pass-license-key',
    scope: 'hashed_license_key',
    license_key_ref: diagnosticRef('dodo_license_key', licenseKey),
    correlation_configured: !!String(process.env.TTDAF_LOG_CORRELATION_SECRET || '').trim()
  }));
}
