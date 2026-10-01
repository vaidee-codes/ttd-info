import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { deleteMachine, getLicense, isKeygenId, listLicenseMachines } from '../_keygen.mjs';
import { updateWhere } from '../_ledger.mjs';
import { audit, requireOperator } from '../_ops.mjs';

// POST /api/ops/reset-activations { license_id, machine_id?, reason }
// Frees one activation (machine_id) or all of them. The old browser keeps its
// current entitlement until it expires (≤ 8 h), then its refresh is terminal.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let licenseId;
  let machineId;
  let reason;
  try {
    const body = readJsonBody(req);
    licenseId = boundedString(body.license_id, { field: 'license_id', max: 36 });
    machineId = boundedString(body.machine_id, { field: 'machine_id', max: 36, required: false });
    reason = boundedString(body.reason, { field: 'reason', max: 300 });
    if (!isKeygenId(licenseId) || (machineId && !isKeygenId(machineId))) return sendError(res, 400, 'invalid_request', 'Invalid licence or activation id.');
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const license = await getLicense(licenseId);
    if (!license) return sendError(res, 404, 'not_found', 'Licence not found.');
    const machines = (await listLicenseMachines(licenseId)).filter((m) => !machineId || m.id === machineId);
    if (machineId && !machines.length) return sendError(res, 404, 'not_found', 'That activation is not on this licence.');
    for (const machine of machines) {
      await deleteMachine(machine.id);
      // Migrated Dodo instances: a tombstone stops an old entitlement re-binding.
      await updateWhere('instance_alias', { keygen_machine_id: machine.id }, { tombstoned_at: new Date().toISOString() }).catch(() => []);
    }
    await audit(operator, machineId ? 'deactivate_activation' : 'reset_activations', licenseId, {
      reason, machines_removed: machines.map((m) => m.id)
    });
    return res.status(200).json({ ok: true, removed: machines.length });
  } catch (error) {
    logProviderFailure('ops_reset_activations', error);
    return sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
  }
}
