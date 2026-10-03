import { PLANS } from './_dodo.mjs';
import { ensureOfflineInvoice, ensureOrderInvoice } from './_invoice.mjs';
import { getLicense } from './_keygen.mjs';
import { getPayment } from './_razorpay.mjs';
import { openSecret, rpc, selectMany, selectOne, updateWhere } from './_ledger.mjs';

// Outbox retry: 5 min, 10 min, 20 min … capped at 3 h between tries, for up to
// 7 days. Daily provider limits reset within a day, so a missed email still goes.
const RETRY_WINDOW_MS = 7 * 24 * 3600e3;
const MAX_BACKOFF_MS = 3 * 3600e3;
export function nextAttemptDelay(attempts) {
  return Math.min(MAX_BACKOFF_MS, 5 * 60e3 * 2 ** Math.max(0, attempts - 1));
}
const REQUEST_TIMEOUT_MS = 10000;
const SUPPORT_EMAIL = 'ttdautofill@gmail.com';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const METHOD_LABELS = { upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay later', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };
const rupees = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const istDate = (ts, withTime = false) => new Date(ts).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata', ...(withTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {})
}) + (withTime ? ' IST' : '');

function siteUrl() {
  const host = String(process.env.PUBLIC_SITE_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'ttd-info.vercel.app').trim();
  return 'https://' + host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// The one email a buyer gets from us: the licence key and the purchase summary
// together (Razorpay sends its own payment receipt). No attachment.
//   payment: { amountPaise, unitPaise, quantity, discountPct, paidAt, paymentId, method, invoiceNumber } | null (grant)
export function licenceEmail({ licenseKey, plan, activations = 1, expiry = null, startsOnActivation = false, payment = null }) {
  const days = PLANS[plan] ? PLANS[plan].days : null;
  const product = days ? `TTD Autofill – ${days} Day Pass` : 'TTD Autofill Pass';
  const qty = payment && payment.quantity > 1 ? payment.quantity : 1;
  const browsers = activations > 1 ? `${activations} browsers` : '1 browser';
  const expiryText = expiry ? istDate(expiry, true) : startsOnActivation && days ? `${days} days from first activation` : '—';
  const subject = `Your TTD Autofill licence key is ready – ${days ? days + '-day pass' : 'pass'}`;
  const site = siteUrl();
  const findKey = site + '/pass/find-key';

  const text = [
    'Your licence key is ready to use.',
    '',
    `Licence key: ${licenseKey}`,
    `Product: ${product}${qty > 1 ? ' × ' + qty : ''}`,
    `Activation limit: ${browsers}`,
    `Expires on: ${expiryText}`,
    '',
    'To activate: open the TTD Autofill extension, choose "Enter licence key", and paste the key.' + (activations > 1 ? ` The same key works on ${browsers}.` : ''),
    ...(payment ? [
      '',
      `Paid: ${rupees(payment.amountPaise)} on ${istDate(payment.paidAt)}`,
      ...(payment.paymentId ? [`Payment ID: ${payment.paymentId}`] : []),
      ...(payment.method ? [`Payment method: ${payment.method}`] : []),
      ...(payment.discountPct ? [`Includes a ${payment.discountPct}% multi-pass discount.`] : []),
      ...(payment.invoiceNumber ? [`Invoice no.: ${payment.invoiceNumber}`] : []),
      'No GST charged (supplier not registered under GST).'
    ] : []),
    '',
    `Lost this email? Find your key any time: ${findKey}`,
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    '',
    'Thanks,',
    'TTD Autofill'
  ].join('\n');

  const e = escapeHtml;
  const row = (label, value, opts = {}) => `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top">${e(label)}</td><td style="padding:6px 0;text-align:right;font-size:13px;color:#111827;${opts.mono ? 'font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;letter-spacing:.3px;word-break:break-all;' : ''}${opts.bold ? 'font-weight:700;' : ''}">${e(value)}</td></tr>`;
  const pill = (t) => `<span style="display:inline-block;padding:2px 10px;border:1px solid #86efac;border-radius:6px;background:#f0fdf4;color:#15803d;font-size:12px;font-weight:600">${e(t)}</span>`;
  const card = (inner) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate"><tr><td style="padding:18px 18px">${inner}</td></tr></table>`;
  const subtotal = payment ? Number(payment.unitPaise || 0) * qty : 0;
  const keyCard = card(`
    ${payment ? `<div style="font-size:28px;font-weight:800;color:#111827">${e(rupees(payment.amountPaise))}</div>` : `<div style="font-size:22px;font-weight:800;color:#111827">Complimentary pass</div>`}
    <div style="font-size:13px;color:#374151;margin:4px 0 14px">Thank you for your purchase!</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:13px;color:#6b7280">Status</td><td style="text-align:right">${pill('Fulfilled')}</td></tr></table>
    <div style="border-top:1px solid #e5e7eb;margin:14px -18px"></div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('Product', product + (qty > 1 ? ' × ' + qty : ''))}
      ${row('Licence key', licenseKey, { mono: true })}
      ${row('Activation limit', browsers)}
      ${row('Expires on', expiryText)}
    </table>
    <div style="font-size:13px;color:#374151;margin-top:14px;line-height:1.6">
      <div style="font-weight:600;margin-bottom:2px">Activation instructions:</div>
      1. Open the TTD Autofill extension.<br>2. Choose <b>Enter licence key</b>.<br>3. Paste the key above${activations > 1 ? ` — the same key works on ${e(browsers)}` : ''}.
    </div>`);
  const payCard = payment ? card(`
    <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:8px">Payment details</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('Paid', istDate(payment.paidAt))}
      ${payment.paymentId ? row('Payment ID', payment.paymentId) : ''}
      ${payment.method ? row('Payment method', payment.method) : ''}
    </table>
    <div style="border-top:1px solid #e5e7eb;margin:10px 0"></div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row(product + ' × ' + qty, rupees(subtotal || payment.amountPaise))}
      ${payment.discountPct && subtotal > payment.amountPaise ? row(`Multi-pass discount (${payment.discountPct}%)`, '−' + rupees(subtotal - payment.amountPaise)) : ''}
      ${row('Total', rupees(payment.amountPaise), { bold: true })}
    </table>
    <div style="font-size:12px;color:#6b7280;margin-top:8px">No GST charged (supplier not registered under GST).${payment.invoiceNumber ? ' Invoice no. ' + e(payment.invoiceNumber) + '.' : ''}</div>`) : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-top:4px solid #7c3aed;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="padding:24px 24px 4px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle"><img src="${site}/assets/logo-128.png" width="28" height="28" alt="" style="display:block;border-radius:6px"></td>
    <td style="vertical-align:middle;padding-left:10px;font-size:20px;font-weight:800">TTD Autofill</td></tr></table>
  <h1 style="font-size:22px;margin:22px 0 16px;font-weight:800">Your licence key is ready to use.</h1>
</td></tr>
<tr><td style="padding:0 24px">${keyCard}</td></tr>
${payCard ? `<tr><td style="padding:14px 24px 0">${payCard}</td></tr>` : ''}
<tr><td style="padding:20px 24px 4px;font-size:14px;line-height:1.6;color:#374151">
  <p style="margin:0 0 10px">Keep this email handy — the key, expiry and activation limit are all listed above.</p>
  <p style="margin:0 0 16px">If you need help, reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#6d28d9">${SUPPORT_EMAIL}</a>.</p>
  <a href="${findKey}" style="display:inline-block;background:#1f2937;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:8px">Find my licence key</a>
  <p style="margin:18px 0 0">Thanks,<br>TTD Autofill</p>
</td></tr>
<tr><td style="padding:20px 24px;border-top:1px solid #f3f4f6;font-size:11px;color:#9ca3af;text-align:center">FireflyAI Softwares · Bangalore 560035 · Not affiliated with TTD</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function sendViaResend({ to, subject, text, html, idempotencyKey, attachments }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || '').trim();
  if (!apiKey || !from) return { ok: false, retry: true, error: 'email_not_configured' };
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to: [to], reply_to: SUPPORT_EMAIL, subject, text, html, ...(attachments && attachments.length ? { attachments } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return { ok: false, retry: true, error: 'network' };
  }
  if (response.ok) return { ok: true, provider: 'resend' };
  const body = await response.json().catch(() => ({}));
  // 429 and 5xx are worth retrying; other 4xx (e.g. an unverified domain) are not.
  const retry = response.status === 429 || response.status >= 500;
  return { ok: false, retry, definite: true, error: `${response.status}:${String(body.name || body.message || '').slice(0, 60)}` };
}

// ---- Amazon SES (≈ $0.10 per 1,000 emails) ----

const b64 = (value) => Buffer.from(value).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
const header = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`);

// RFC 5322 message: text + HTML alternatives, plus base64 attachments.
export function buildMime({ from, to, replyTo, subject, text, html, attachments = [], boundary = 'ttdaf' + Date.now().toString(36) }) {
  const alt = boundary + '-alt';
  const lines = [
    `From: ${from}`, `To: ${to}`, `Reply-To: ${replyTo}`, `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text), '',
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html), '',
    `--${alt}--`
  ];
  for (const a of attachments) {
    const name = String(a.filename).replace(/[^A-Za-z0-9._-]/g, '_');
    lines.push('', `--${boundary}`, `Content-Type: application/pdf; name="${name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`, '', String(a.content).replace(/.{1,76}/g, '$&\r\n').trimEnd());
  }
  lines.push('', `--${boundary}--`, '');
  return lines.join('\r\n');
}

let sesClient = null;
let sesSend = null;
export function setSesSenderForTests(fn) { sesSend = fn; }

async function sesSender() {
  if (sesSend) return sesSend;
  const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  sesClient = sesClient || new SESv2Client({
    region: String(process.env.SES_REGION || 'ap-south-1').trim(),
    credentials: { accessKeyId: String(process.env.SES_ACCESS_KEY_ID).trim(), secretAccessKey: String(process.env.SES_SECRET_ACCESS_KEY).trim() },
    maxAttempts: 2
  });
  return (input) => sesClient.send(new SendEmailCommand(input), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

const sesConfigured = () => !!(String(process.env.SES_ACCESS_KEY_ID || '').trim() && String(process.env.SES_SECRET_ACCESS_KEY || '').trim()
  && String(process.env.SES_FROM || process.env.RESEND_FROM || '').trim());

async function sendViaSes({ to, subject, text, html, attachments }) {
  if (!sesConfigured() && !sesSend) return { ok: false, retry: true, error: 'email_not_configured' };
  const from = String(process.env.SES_FROM || process.env.RESEND_FROM || '').trim();
  const raw = buildMime({ from, to, replyTo: SUPPORT_EMAIL, subject, text, html, attachments });
  try {
    const send = await sesSender();
    const configurationSet = String(process.env.SES_CONFIGURATION_SET || '').trim();
    await send({ Content: { Raw: { Data: Buffer.from(raw) } }, Destination: { ToAddresses: [to] }, ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}) });
    return { ok: true, provider: 'ses' };
  } catch (error) {
    const status = error && error.$metadata && error.$metadata.httpStatusCode;
    const name = String(error && (error.name || error.code) || 'error').slice(0, 60);
    // No HTTP status → network/timeout: SES may have sent it, so retry later rather than fall back.
    if (!status) return { ok: false, retry: true, error: 'ses:network' };
    const retry = status === 429 || status >= 500 || /TooManyRequests|LimitExceeded|Throttl/.test(name);
    return { ok: false, retry, definite: true, error: `ses:${status}:${name}` };
  }
}

// ---- Brevo (free plan: 300 emails a day) ----

function parseFrom(value) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: value.trim() };
}

async function sendViaBrevo({ to, subject, text, html, attachments }) {
  const apiKey = String(process.env.BREVO_API_KEY || '').trim();
  const from = String(process.env.BREVO_FROM || process.env.SES_FROM || process.env.RESEND_FROM || '').trim();
  if (!apiKey || !from) return { ok: false, retry: true, error: 'email_not_configured' };
  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: parseFrom(from), to: [{ email: to }], replyTo: { email: SUPPORT_EMAIL }, subject, textContent: text, htmlContent: html,
        ...(attachments && attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.content })) } : {})
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return { ok: false, retry: true, error: 'brevo:network' };
  }
  if (response.ok) return { ok: true, provider: 'brevo' };
  const body = await response.json().catch(() => ({}));
  // 402 = out of daily credits; 429 = rate limited; both clear later.
  const retry = response.status === 402 || response.status === 429 || response.status >= 500;
  return { ok: false, retry, definite: true, error: `brevo:${response.status}:${String(body.code || body.message || '').slice(0, 60)}` };
}

const SENDERS = { ses: sendViaSes, resend: sendViaResend, brevo: sendViaBrevo };

// Providers in order (EMAIL_PROVIDERS, default "ses,resend,brevo"); unconfigured
// ones are skipped. Each definite refusal (an error answer, a daily limit) moves
// on to the next provider. A network failure stops the chain — that provider may
// have sent it — and the outbox retries a few minutes later instead.
export function emailProviders() {
  const list = String(process.env.EMAIL_PROVIDERS || process.env.EMAIL_PROVIDER || 'ses,resend,brevo')
    .split(',').map((x) => x.trim().toLowerCase()).filter((x) => SENDERS[x]);
  return [...new Set(list)];
}

export async function sendEmail(message) {
  const errors = [];
  let retry = false;
  let configured = 0;
  for (const name of emailProviders()) {
    const result = await SENDERS[name](message);
    if (result.ok) return { ...result, ...(errors.length ? { fallbackFrom: errors.join(';') } : {}) };
    if (result.error === 'email_not_configured') continue;
    configured++;
    errors.push(result.error);
    retry = retry || !!result.retry;
    if (!result.definite) return { ok: false, retry: true, error: errors.join(';') };
  }
  if (!configured) return { ok: false, retry: true, error: 'email_not_configured' };
  return { ok: false, retry, error: errors.join(';').slice(0, 300) };
}

async function paymentMethod(paymentId) {
  if (!paymentId) return null;
  try {
    const payment = await getPayment(paymentId);
    return METHOD_LABELS[payment && payment.method] || (payment && payment.method) || null;
  } catch {
    return null;
  }
}

async function licenceExpiry(keygenLicenseId) {
  if (!keygenLicenseId) return null;
  try {
    const license = await getLicense(keygenLicenseId);
    return license && license.attributes && license.attributes.expiry || null;
  } catch {
    return null;
  }
}

// The email for a Razorpay order (with its payment summary).
export async function orderEmail(order, fulfilment) {
  const invoice = await ensureOrderInvoice(order).catch(() => null);
  const [method, expiry] = await Promise.all([paymentMethod(order.razorpay_payment_id), licenceExpiry(fulfilment.keygen_license_id)]);
  const quantity = Number(order.quantity || 1);
  return licenceEmail({
    licenseKey: openSecret(fulfilment.license_key_enc), plan: order.plan, activations: quantity, expiry,
    payment: { amountPaise: order.amount_paise, unitPaise: PLANS[order.plan] && PLANS[order.plan].net, quantity, discountPct: Number(order.discount_pct || 0),
      paidAt: order.paid_at || order.fulfilled_at || new Date().toISOString(), paymentId: order.razorpay_payment_id, method, invoiceNumber: invoice && invoice.number }
  });
}

// The email for an offline sale (paid) or a grant (complimentary).
export async function offlineEmail(sale) {
  const invoice = sale.kind === 'paid' ? await ensureOfflineInvoice(sale).catch(() => null) : null;
  const expiry = await licenceExpiry(sale.keygen_license_id);
  return licenceEmail({
    licenseKey: openSecret(sale.license_key_enc), plan: sale.plan, activations: Number(sale.activations || 1), expiry,
    startsOnActivation: sale.kind === 'grant' && !expiry,
    payment: sale.kind === 'paid' ? { amountPaise: sale.amount_inr * 100, unitPaise: sale.amount_inr * 100, quantity: 1, discountPct: 0,
      paidAt: sale.provisioned_at || sale.created_at, paymentId: sale.reference, method: METHOD_LABELS[sale.method] || sale.method, invoiceNumber: invoice && invoice.number } : null
  });
}

// Sends one queued outbox row. Safe to call repeatedly: a sent row is skipped,
// and Resend's idempotency key suppresses a duplicate send within 24 h.
export async function deliverOutboxRow(row) {
  if (!row || row.status !== 'queued') return false;
  let message;
  if (row.kind === 'licence_key') {
    const [order, fulfilment] = await Promise.all([
      selectOne('orders', { id: row.order_id }),
      selectOne('fulfilments', { order_id: row.order_id })
    ]);
    if (!order || !fulfilment || fulfilment.status !== 'provisioned') return false;
    message = await orderEmail(order, fulfilment);
  } else if (row.kind === 'licence_key_offline') {
    const sale = await selectOne('offline_sales', { id: row.offline_sale_id });
    if (!sale || sale.status !== 'provisioned') return false;
    message = await offlineEmail(sale);
  } else {
    return false;
  }
  // Claim the row first: only one concurrent sender (page confirm, webhooks,
  // cron) may send it. Losing the claim means someone else is sending it now.
  if (!await rpc('claim_outbox_row', { p_id: row.id })) return false;
  const result = await sendEmail({ to: row.to_email, ...message, idempotencyKey: `${row.kind}/${row.order_id || row.offline_sale_id}` });
  if (result.error === 'email_not_configured') {
    await updateWhere('email_outbox', { id: row.id, status: 'queued' }, { claimed_until: null }).catch(() => []);
    return false;
  }
  const attempts = Number(row.attempts || 0) + 1;
  if (result.ok) {
    await updateWhere('email_outbox', { id: row.id, status: 'queued' }, { status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null, provider: result.provider || null, claimed_until: null });
  } else {
    const expired = Date.now() - Date.parse(row.created_at || new Date()) > RETRY_WINDOW_MS;
    const failed = !result.retry || expired;
    await updateWhere('email_outbox', { id: row.id, status: 'queued' }, {
      status: failed ? 'failed' : 'queued', attempts, last_error: result.error, claimed_until: null,
      next_attempt_at: new Date(Date.now() + nextAttemptDelay(attempts)).toISOString()
    });
  }
  console.log(JSON.stringify({ event: 'email_delivery', kind: row.kind, ok: result.ok, provider: result.provider || null, fallback_from: result.fallbackFrom || null, attempts, error: result.ok ? null : result.error }));
  return result.ok;
}

// /ops "re-send licence email": rebuilds the email for any licence (online
// order, offline sale, or a licence migrated from Dodo) and sends it now.
export async function resendLicenceEmail(license, { to } = {}) {
  const attributes = license.attributes || {};
  const metadata = attributes.metadata || {};
  let message;
  let recipient = to || null;
  if (metadata.orderId) {
    const [order, fulfilment] = await Promise.all([selectOne('orders', { id: metadata.orderId }), selectOne('fulfilments', { order_id: metadata.orderId })]);
    if (order && fulfilment && fulfilment.status === 'provisioned') {
      recipient = recipient || order.email;
      message = await orderEmail(order, fulfilment);
    }
  }
  if (!message) {
    const sale = await selectOne('offline_sales', { keygen_license_id: license.id });
    if (sale && sale.status === 'provisioned') {
      recipient = recipient || sale.email;
      message = await offlineEmail(sale);
    }
  }
  if (!message) {
    recipient = recipient || metadata.email;
    message = licenceEmail({ licenseKey: attributes.key, plan: metadata.plan, activations: Number(attributes.maxMachines || 1), expiry: attributes.expiry || null });
  }
  if (!recipient) return { ok: false, error: 'no_email' };
  const result = await sendEmail({ to: recipient, ...message, idempotencyKey: `resend/${license.id}/${Date.now()}` });
  return { ...result, to: recipient };
}

export async function deliverForOrder(orderId) {
  const row = await selectOne('email_outbox', { kind: 'licence_key', order_id: orderId });
  return deliverOutboxRow(row);
}

export async function deliverForOfflineSale(saleId) {
  const row = await selectOne('email_outbox', { kind: 'licence_key_offline', offline_sale_id: saleId });
  return deliverOutboxRow(row);
}

export async function drainOutbox(limit = 50) {
  const rows = await selectMany('email_outbox', {
    select: '*', status: 'eq.queued', next_attempt_at: 'lte.' + new Date().toISOString(), order: 'next_attempt_at.asc', limit: String(limit)
  });
  let sent = 0;
  for (const row of rows) {
    try {
      if (await deliverOutboxRow(row)) sent++;
    } catch (error) {
      console.error(JSON.stringify({ event: 'email_delivery_error', code: String(error && error.code || '').slice(0, 40) }));
    }
  }
  return { queued: rows.length, sent };
}
