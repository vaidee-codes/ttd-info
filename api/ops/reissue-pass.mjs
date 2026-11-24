import { logProviderFailure, PLANS } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { createLicenseWithKey, getLicense, isKeygenId } from '../_keygen.mjs';
import { insertOne, licenceKeyHash, openSecret, sealSecret, selectOne, updateWhere } from '../_ledger.mjs';
import { audit, requireOperator } from '../_ops.mjs';
import { generateLicenceKey } from '../_payments.mjs';

const REQUEST_ID = /^[A-Za-z0-9-]{8,24}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// How long the existing pass runs: its plan, or failing that its own length.
function passDays(attributes, metadata) {
  if (PLANS[metadata.plan]) return PLANS[metadata.plan].days;
  const created = Date.parse(attributes.created || '');
  const expiry = Date.parse(attributes.expiry || '');
  if (Number.isFinite(created) && Number.isFinite(expiry) && expiry > created) return Math.max(1, Math.round((expiry - created) / DAY_MS));
  return null;
}

// POST /api/ops/reissue-pass { license_id, request_id }
// One click: a new pass on the same policy, plan, browser limit and buyer email
// as an existing licence, with a NEW key and dates starting now. The existing
// licence is left as it is. It is recorded as a free grant (method "other",
// reference "reissue/<request_id>"), so a retried click with the same
// request_id returns the same key, and find-my-key and the licence email work.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let licenseId;
  let requestId;
  try {
    const body = readJsonBody(req);
    licenseId = boundedString(body.license_id, { field: 'license_id', max: 36 });
    requestId = boundedString(body.request_id, { field: 'request_id', max: 24, pattern: REQUEST_ID });
    if (!isKeygenId(licenseId)) return sendError(res, 400, 'invalid_request', 'Invalid licence id.');
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const source = await getLicense(licenseId);
    if (!source) return sendError(res, 404, 'not_found', 'Licence not found.');
    const attributes = source.attributes || {};
    const metadata = attributes.metadata || {};
    const policyId = source.relationships && source.relationships.policy && source.relationships.policy.data && source.relationships.policy.data.id;
    const days = passDays(attributes, metadata);
    if (!policyId || !days) return sendError(res, 409, 'unknown_pass', 'Cannot tell this licence\'s pass length. Issue a new one from "Record an offline sale or a grant".');
    const plan = PLANS[metadata.plan] ? metadata.plan : days + 'd';
    const activations = Math.min(1000, Math.max(1, Number(attributes.maxMachines) || 1));
    const email = metadata.email || null;
    const reference = 'reissue/' + requestId;
    const note = 'New pass from licence ' + source.id;

    await insertOne('offline_sales', {
      plan, kind: 'grant', method: 'other', reference, amount_inr: 0, activations, email, note,
      license_key_enc: sealSecret(generateLicenceKey()), created_by: operator.id
    }, { onConflict: 'method,reference', ignoreDuplicates: true });
    const row = await selectOne('offline_sales', { method: 'other', reference });
    if (!row) throw new Error('reissue row missing');
    if (row.note !== note) return sendError(res, 409, 'duplicate_reference', 'This request was already used for another licence. Reload the page and try again.');

    const licenseKey = openSecret(row.license_key_enc);
    let newId = row.keygen_license_id;
    let expiry = null;
    if (row.status !== 'provisioned') {
      expiry = new Date(Date.now() + days * DAY_MS).toISOString();
      const license = await createLicenseWithKey({
        key: licenseKey,
        policyId,
        maxMachines: activations,
        expiry,
        metadata: {
          source: 'grant',
          method: 'other',
          reference,
          amountInr: 0,
          plan,
          email,
          note,
          offlineSaleId: row.id,
          reissuedFrom: source.id,
          publicProductId: metadata.publicProductId || (PLANS[plan] && PLANS[plan].product_id) || null
        }
      });
      if (!license || !license.id) throw new Error('reissue licence missing');
      newId = license.id;
      expiry = license.attributes && license.attributes.expiry || expiry;
      await insertOne('licence_authority', {
        key_hash: licenceKeyHash(licenseKey), authority: 'keygen', public_license_id: license.id,
        keygen_license_id: license.id, source: 'grant'
      }, { onConflict: 'key_hash', ignoreDuplicates: true });
      await updateWhere('offline_sales', { id: row.id, status: 'pending' },
        { status: 'provisioned', keygen_license_id: license.id, provisioned_at: new Date().toISOString() });
      await audit(operator, 'pass_reissued', license.id, { from: source.id, plan, activations, expiry });
    } else {
      const existing = await getLicense(newId);
      expiry = existing && existing.attributes && existing.attributes.expiry || null;
    }
    return res.status(200).json({ ok: true, license_key: licenseKey, license_id: newId, from: source.id, plan, activations, expiry, email });
  } catch (error) {
    logProviderFailure('ops_reissue_pass', error);
    return sendError(res, 503, 'licensing_unavailable', 'Could not create the new pass. Click again; the same click returns the same key.');
  }
}
