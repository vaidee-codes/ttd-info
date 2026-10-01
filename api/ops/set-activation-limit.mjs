import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { getLicense, isKeygenId, listLicenseMachines, setLicenseMaxMachines } from '../_keygen.mjs';
import { audit, requireOperator } from '../_ops.mjs';

// POST /api/ops/set-activation-limit { license_id, activations, reason }
// Changes how many browsers a licence may be activated on. Lowering it below
// the number already activated is refused: free those activations first.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let licenseId;
  let activations;
  let reason;
  try {
    const body = readJsonBody(req);
    licenseId = boundedString(body.license_id, { field: 'license_id', max: 36 });
    reason = boundedString(body.reason, { field: 'reason', max: 300 });
    activations = Number(body.activations);
    if (!isKeygenId(licenseId)) return sendError(res, 400, 'invalid_request', 'Invalid licence id.');
    if (!Number.isInteger(activations) || activations < 1 || activations > 1000) {
      return sendError(res, 400, 'invalid_request', 'Browsers allowed must be a whole number from 1 to 1000.');
    }
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const license = await getLicense(licenseId);
    if (!license) return sendError(res, 404, 'not_found', 'Licence not found.');
    const inUse = (await listLicenseMachines(licenseId)).length;
    if (activations < inUse) {
      return sendError(res, 409, 'limit_below_use', `${inUse} browser(s) are activated on this licence. Deactivate some first, or choose ${inUse} or more.`);
    }
    const previous = Number(license.attributes && license.attributes.maxMachines) || 1;
    // Migrated licences record their base limit for the legacy bridge; keep it in step.
    const metadata = license.attributes && license.attributes.metadata;
    await setLicenseMaxMachines(licenseId, activations,
      metadata && metadata.baseMaxMachines != null ? { ...metadata, baseMaxMachines: activations } : undefined);
    await audit(operator, 'set_activation_limit', licenseId, { reason, from: previous, to: activations });
    return res.status(200).json({ ok: true, activations, previous });
  } catch (error) {
    logProviderFailure('ops_set_activation_limit', error);
    return sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
  }
}
