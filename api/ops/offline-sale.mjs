import { logProviderFailure, PLANS, ProviderConfigurationError } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { createLicenseWithKey } from '../_keygen.mjs';
import { insertOne, licenceKeyHash, openSecret, sealSecret, selectOne, updateWhere } from '../_ledger.mjs';
import { deliverForOfflineSale } from '../_email.mjs';
import { ensureOfflineInvoice } from '../_invoice.mjs';
import { audit, requireOperator } from '../_ops.mjs';
import { generateLicenceKey, normaliseEmail } from '../_payments.mjs';

const METHODS = new Set(['upi', 'bank', 'cash', 'other']);
const REFERENCE = /^[A-Za-z0-9._\-/ ]{3,80}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

function policyFor(kind, plan) {
  let map;
  try {
    map = JSON.parse(String(process.env[kind === 'grant' ? 'KEYGEN_GRANT_POLICIES' : 'KEYGEN_PLAN_POLICIES'] || '{}'));
  } catch {
    map = {};
  }
  if (!map[plan]) throw new ProviderConfigurationError();
  return map[plan];
}

// POST /api/ops/offline-sale { plan, kind: 'paid'|'grant', method, reference, amount_inr, activations?, email?, note?, send_email? }
// `send_email: true` emails the key (and, for a paid sale, its invoice) to `email`; otherwise nothing is sent.
// `activations` = how many browsers the one key may be activated on (default 1).
// Issues a licence for a payment received outside Razorpay (or a complimentary
// grant). The (method, reference) pair is unique, so a UTR is never used twice;
// retrying the same request returns the same key.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;

  let sale;
  let sendEmail = false;
  try {
    const body = readJsonBody(req);
    const plan = boundedString(body.plan, { field: 'plan', max: 4 });
    const kind = boundedString(body.kind, { field: 'kind', max: 5 });
    const method = boundedString(body.method, { field: 'method', max: 5 }).toLowerCase();
    const reference = boundedString(body.reference, { field: 'reference', max: 80, pattern: REFERENCE });
    const emailRaw = boundedString(body.email, { field: 'email', max: 254, pattern: EMAIL, required: false });
    const note = boundedString(body.note, { field: 'note', max: 300, required: false });
    const amount = Number(body.amount_inr);
    if (!PLANS[plan] || !['paid', 'grant'].includes(kind) || !METHODS.has(method)) {
      return sendError(res, 400, 'invalid_request', 'Choose a plan, whether it is paid or a grant, and a payment method.');
    }
    if (!Number.isInteger(amount) || amount < 0 || amount > 100000 || (kind === 'paid' && amount === 0)) {
      return sendError(res, 400, 'invalid_request', 'Enter the amount received in rupees (0 only for a grant).');
    }
    const activations = body.activations == null || body.activations === '' ? 1 : Number(body.activations);
    if (!Number.isInteger(activations) || activations < 1 || activations > 1000) {
      return sendError(res, 400, 'invalid_request', 'Browsers allowed must be a whole number from 1 to 1000.');
    }
    sendEmail = body.send_email === true;
    if (sendEmail && !emailRaw) return sendError(res, 400, 'invalid_request', 'Enter the buyer email to send the licence email.');
    sale = { plan, kind, method, reference, amount_inr: amount, activations, email: emailRaw ? normaliseEmail(emailRaw) : null, note: note || null };
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const policyId = policyFor(sale.kind, sale.plan);
    await insertOne('offline_sales', { ...sale, license_key_enc: sealSecret(generateLicenceKey()), created_by: operator.id },
      { onConflict: 'method,reference', ignoreDuplicates: true });
    const row = await selectOne('offline_sales', { method: sale.method, reference: sale.reference });
    if (!row) throw new Error('offline sale row missing');
    if (row.plan !== sale.plan || row.kind !== sale.kind || row.amount_inr !== sale.amount_inr || Number(row.activations || 1) !== sale.activations) {
      return sendError(res, 409, 'duplicate_reference', `This ${sale.method.toUpperCase()} reference was already used for another licence${row.keygen_license_id ? ' (' + row.keygen_license_id + ')' : ''}.`);
    }
    const licenseKey = openSecret(row.license_key_enc);
    let licenseId = row.keygen_license_id;
    if (row.status !== 'provisioned') {
      const license = await createLicenseWithKey({
        key: licenseKey,
        policyId,
        maxMachines: sale.activations,
        metadata: {
          source: sale.kind === 'grant' ? 'grant' : 'offline',
          method: sale.method,
          reference: sale.reference,
          amountInr: sale.amount_inr,
          plan: sale.plan,
          email: sale.email,
          note: sale.note,
          offlineSaleId: row.id,
          publicProductId: PLANS[sale.plan].product_id
        }
      });
      licenseId = license.id;
      await insertOne('licence_authority', {
        key_hash: licenceKeyHash(licenseKey), authority: 'keygen', public_license_id: license.id,
        keygen_license_id: license.id, source: sale.kind === 'grant' ? 'grant' : 'offline'
      }, { onConflict: 'key_hash', ignoreDuplicates: true });
      await updateWhere('offline_sales', { id: row.id, status: 'pending' },
        { status: 'provisioned', keygen_license_id: license.id, provisioned_at: new Date().toISOString() });
      await audit(operator, sale.kind === 'grant' ? 'grant_created' : 'offline_sale_created', license.id, {
        method: sale.method, reference: sale.reference, amount_inr: sale.amount_inr, plan: sale.plan, activations: sale.activations
      });
    }
    // Paid offline sales always get an invoice (for the records). Nothing is
    // emailed unless the operator asked for it.
    const current = await selectOne('offline_sales', { id: row.id });
    const invoice = sale.kind === 'paid' ? await ensureOfflineInvoice(current).catch(() => null) : null;
    let emailed = false;
    if (sendEmail && current.email) {
      await insertOne('email_outbox', { kind: 'licence_key_offline', offline_sale_id: row.id, to_email: current.email },
        { onConflict: 'kind,offline_sale_id', ignoreDuplicates: true })
        .catch((error) => console.error(JSON.stringify({ event: 'offline_email_queue_error', code: String(error && (error.code || error.message) || '').slice(0, 80) })));
      emailed = await deliverForOfflineSale(row.id).catch((error) => {
        console.error(JSON.stringify({ event: 'offline_email_error', code: String(error && (error.code || error.message) || '').slice(0, 80) }));
        return false;
      });
      await audit(operator, 'offline_licence_emailed', licenseId, { sent: emailed }).catch(() => {});
    }
    return res.status(200).json({ ok: true, license_key: licenseKey, license_id: licenseId, plan: sale.plan, kind: sale.kind,
      activations: sale.activations, invoice_number: invoice ? invoice.number : null, email_sent: emailed });
  } catch (error) {
    logProviderFailure('ops_offline_sale', error);
    return sendError(res, 503, 'licensing_unavailable', 'Could not issue the licence. Try again; the same reference will return the same key.');
  }
}
