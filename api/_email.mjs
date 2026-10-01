import { PLANS } from './_dodo.mjs';
import { ensureOfflineInvoice, ensureOrderInvoice, renderInvoicePdf } from './_invoice.mjs';
import { openSecret, selectMany, selectOne, updateWhere } from './_ledger.mjs';

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

export function licenceEmail({ licenseKey, plan, invoiceNumber, activations = 1 }) {
  const days = PLANS[plan] ? PLANS[plan].days : null;
  const label = days ? `${days}-day pass` : 'pass';
  const subject = `Your TTD Autofill ${label} licence key`;
  const browsers = activations > 1 ? `${activations} browsers` : 'one browser';
  const validity = days ? `The pass is valid for ${days} days on ${browsers}.` : `The pass works on ${browsers}.`;
  const invoiceLine = invoiceNumber ? `Your invoice ${invoiceNumber} is attached.` : '';
  const text = [
    `Thank you for buying a TTD Autofill ${label}.`,
    '',
    `Your licence key: ${licenseKey}`,
    '',
    'To activate: open the TTD Autofill extension, choose "Enter licence key", and paste the key.',
    validity,
    ...(invoiceLine ? ['', invoiceLine] : []),
    '',
    `Questions or a problem with activation? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    '',
    'Crimson',
    'TTD Autofill'
  ].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:520px">
<p>Thank you for buying a TTD Autofill ${escapeHtml(label)}.</p>
<p style="margin:20px 0 6px;color:#6b7280;font-size:13px">Your licence key</p>
<p style="margin:0 0 20px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:10px;font-family:ui-monospace,Menlo,monospace;font-size:16px;letter-spacing:.5px">${escapeHtml(licenseKey)}</p>
<p>To activate: open the TTD Autofill extension, choose <b>Enter licence key</b>, and paste the key.</p>
<p>${escapeHtml(validity)}</p>
${invoiceLine ? `<p>${escapeHtml(invoiceLine)}</p>` : ''}
<p>Questions or a problem with activation? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<p>Crimson<br>TTD Autofill</p>
</div>`;
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

// Sends one queued outbox row. Safe to call repeatedly: a sent row is skipped,
// and Resend's idempotency key suppresses a duplicate send within 24 h.
export async function deliverOutboxRow(row) {
  if (!row || row.status !== 'queued') return false;
  let message;
  let invoice = null;
  if (row.kind === 'licence_key') {
    const [order, fulfilment] = await Promise.all([
      selectOne('orders', { id: row.order_id }),
      selectOne('fulfilments', { order_id: row.order_id })
    ]);
    if (!order || !fulfilment || fulfilment.status !== 'provisioned') return false;
    invoice = await ensureOrderInvoice(order);
    message = licenceEmail({ licenseKey: openSecret(fulfilment.license_key_enc), plan: order.plan, invoiceNumber: invoice && invoice.number, activations: Number(order.quantity || 1) });
  } else if (row.kind === 'licence_key_offline') {
    const sale = await selectOne('offline_sales', { id: row.offline_sale_id });
    if (!sale || sale.status !== 'provisioned') return false;
    if (sale.kind === 'paid') invoice = await ensureOfflineInvoice(sale);
    message = licenceEmail({ licenseKey: openSecret(sale.license_key_enc), plan: sale.plan, invoiceNumber: invoice && invoice.number, activations: Number(sale.activations || 1) });
  } else {
    return false;
  }
  const attachments = invoice
    ? [{ filename: `invoice-${invoice.number.replace(/\//g, '-')}.pdf`, content: (await renderInvoicePdf(invoice)).toString('base64') }]
    : [];
  const result = await sendEmail({ to: row.to_email, ...message, attachments, idempotencyKey: `${row.kind}/${row.order_id || row.offline_sale_id}` });
  if (result.error === 'email_not_configured') return false;
  const attempts = Number(row.attempts || 0) + 1;
  if (result.ok) {
    await updateWhere('email_outbox', { id: row.id, status: 'queued' }, { status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null, provider: result.provider || null });
  } else {
    const expired = Date.now() - Date.parse(row.created_at || new Date()) > RETRY_WINDOW_MS;
    const failed = !result.retry || expired;
    await updateWhere('email_outbox', { id: row.id, status: 'queued' }, {
      status: failed ? 'failed' : 'queued', attempts, last_error: result.error,
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
  let invoice = null;
  let recipient = to || null;
  if (metadata.orderId) {
    const [order, fulfilment] = await Promise.all([selectOne('orders', { id: metadata.orderId }), selectOne('fulfilments', { order_id: metadata.orderId })]);
    if (order && fulfilment && fulfilment.status === 'provisioned') {
      invoice = await ensureOrderInvoice(order);
      recipient = recipient || order.email;
      message = licenceEmail({ licenseKey: openSecret(fulfilment.license_key_enc), plan: order.plan, invoiceNumber: invoice && invoice.number, activations: Number(order.quantity || 1) });
    }
  }
  if (!message) {
    const sale = await selectOne('offline_sales', { keygen_license_id: license.id });
    if (sale && sale.status === 'provisioned') {
      if (sale.kind === 'paid') invoice = await ensureOfflineInvoice(sale);
      recipient = recipient || sale.email;
      message = licenceEmail({ licenseKey: openSecret(sale.license_key_enc), plan: sale.plan, invoiceNumber: invoice && invoice.number, activations: Number(sale.activations || 1) });
    }
  }
  if (!message) {
    recipient = recipient || metadata.email;
    message = licenceEmail({ licenseKey: attributes.key, plan: metadata.plan, activations: Number(attributes.maxMachines || 1) });
  }
  if (!recipient) return { ok: false, error: 'no_email' };
  const attachments = invoice ? [{ filename: `invoice-${invoice.number.replace(/\//g, '-')}.pdf`, content: (await renderInvoicePdf(invoice)).toString('base64') }] : [];
  const result = await sendEmail({ to: recipient, ...message, attachments, idempotencyKey: `resend/${license.id}/${Date.now()}` });
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
