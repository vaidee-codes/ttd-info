import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { findLicensesByMetadata, getLicense, isKeygenId, listLicenseMachines, validateKey } from '../_keygen.mjs';
import { requireOperator } from '../_ops.mjs';

function licenceView(license, machines) {
  const a = license.attributes || {};
  const m = a.metadata || {};
  return {
    id: license.id,
    key: a.key,
    status: a.status,
    expiry: a.expiry,
    max_machines: a.maxMachines,
    created: a.created,
    source: m.source || null,
    plan: m.plan || null,
    email: m.email || null,
    reference: m.reference || null,
    order_id: m.orderId || null,
    machines: machines.map((x) => ({ id: x.id, name: x.attributes && x.attributes.name, created: x.attributes && x.attributes.created }))
  };
}

// POST /api/ops/lookup { query } — a licence key, a licence id, or a buyer email.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let query;
  try {
    query = boundedString(readJsonBody(req).query, { field: 'query', max: 254 });
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    let licenses = [];
    if (query.includes('@')) {
      const at = query.lastIndexOf('@');
      const email = query.slice(0, at) + '@' + query.slice(at + 1).toLowerCase();
      licenses = await findLicensesByMetadata({ email });
    } else if (isKeygenId(query)) {
      const license = await getLicense(query);
      licenses = license ? [license] : await findLicensesByMetadata({ orderId: query });
    } else {
      const check = await validateKey(query);
      licenses = check.license ? [check.license] : [];
    }
    const results = [];
    for (const license of licenses.slice(0, 20)) {
      results.push(licenceView(license, await listLicenseMachines(license.id)));
    }
    return res.status(200).json({ ok: true, results });
  } catch (error) {
    logProviderFailure('ops_lookup', error);
    return sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
  }
}
