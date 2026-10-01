import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { PLANS } from './_dodo.mjs';
import { insertOne, rpc, selectOne } from './_ledger.mjs';

const PREFIX = 'TTDA';

// Indian financial year (April–March): 15 Mar 2027 → "2026-27".
export function financialYear(date = new Date()) {
  const d = new Date(date);
  const ist = new Date(d.getTime() + 5.5 * 3600e3);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function sellerDetails() {
  return {
    name: String(process.env.INVOICE_SELLER_NAME || 'FireflyAI Softwares').trim(),
    address: String(process.env.INVOICE_SELLER_ADDRESS || 'Proprietor: Roopa Nayanika B, Bangalore 560035, Karnataka, India').trim(),
    email: String(process.env.INVOICE_SELLER_EMAIL || 'ttdautofill@gmail.com').trim(),
    gstin: String(process.env.INVOICE_GSTIN || '').trim() || null
  };
}

function itemFor(plan) {
  const days = PLANS[plan] ? PLANS[plan].days : null;
  return days ? `TTD Autofill Assistant — ${days}-day pass (1 licence key)` : 'TTD Autofill Assistant pass';
}

// One invoice per sale, whatever the number of retries: a unique key on the sale
// id, and the number is only allocated when no invoice exists yet.
async function ensureInvoice({ link, issuedAt, buyerEmail, plan, amountPaise, paymentRef, paymentMethod, activations, quantity = 1, discountPct = 0 }) {
  const existing = await selectOne('invoices', link);
  if (existing) return existing;
  const fy = financialYear(issuedAt);
  const seq = Number(await rpc('allocate_invoice_seq', { p_fy: fy }));
  if (!Number.isInteger(seq) || seq < 1) throw new Error('invoice number allocation failed');
  let item = itemFor(plan);
  if (quantity > 1) item = itemFor(plan).replace('(1 licence key)', `(one key for ${quantity} browsers)`);
  else if (activations && activations > 1) item += ` — valid on ${activations} browsers`;
  await insertOne('invoices', {
    ...link, number: `${PREFIX}/${fy}/${String(seq).padStart(4, '0')}`, fy, seq,
    issued_at: new Date(issuedAt).toISOString(), buyer_email: buyerEmail || null, item,
    amount_paise: amountPaise, quantity, discount_pct: discountPct, currency: 'INR', payment_ref: paymentRef || null, payment_method: paymentMethod || null,
    seller: sellerDetails()
  }, { onConflict: Object.keys(link)[0], ignoreDuplicates: true });
  // A concurrent call may have won; its invoice is the one (the spare number is
  // recorded only in the counter, never on an invoice).
  return selectOne('invoices', link);
}

export function ensureOrderInvoice(order) {
  return ensureInvoice({
    link: { order_id: order.id }, issuedAt: order.paid_at || order.fulfilled_at || new Date(), buyerEmail: order.email,
    plan: order.plan, amountPaise: order.amount_paise, paymentRef: order.razorpay_payment_id, paymentMethod: 'Razorpay',
    quantity: Number(order.quantity || 1), discountPct: Number(order.discount_pct || 0)
  });
}

export function ensureOfflineInvoice(sale) {
  return ensureInvoice({
    link: { offline_sale_id: sale.id }, issuedAt: sale.provisioned_at || sale.created_at || new Date(), buyerEmail: sale.email,
    plan: sale.plan, amountPaise: sale.amount_inr * 100, paymentRef: sale.reference,
    paymentMethod: { upi: 'UPI', bank: 'Bank transfer', cash: 'Cash', other: 'Other' }[sale.method] || sale.method,
    activations: Number(sale.activations || 1)
  });
}

const rupees = (paise) => 'Rs. ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export async function renderInvoicePdf(invoice) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${invoice.number}`);
  pdf.setAuthor(invoice.seller.name);
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.13, 0.16);
  const muted = rgb(0.42, 0.45, 0.5);
  const violet = rgb(0.36, 0.13, 0.71);
  const text = (s, x, y, { size = 10, font = regular, color = ink } = {}) => page.drawText(String(s), { x, y, size, font, color });
  const right = (s, xRight, y, opts = {}) => text(s, xRight - (opts.font || regular).widthOfTextAtSize(String(s), opts.size || 10), y, opts);

  text(invoice.seller.gstin ? 'TAX INVOICE' : 'INVOICE', 50, 780, { size: 20, font: bold, color: violet });
  right(invoice.number, 545, 784, { size: 11, font: bold });
  right('Date: ' + date(invoice.issued_at), 545, 768, { color: muted });

  text('From', 50, 730, { size: 9, color: muted });
  let y = 715;
  text(invoice.seller.name, 50, y, { font: bold }); y -= 14;
  for (const line of String(invoice.seller.address || '').split(/\n|,\s*(?=\S)/).filter(Boolean).slice(0, 4)) { text(line.trim(), 50, y); y -= 13; }
  text(invoice.seller.email, 50, y); y -= 13;
  if (invoice.seller.gstin) text('GSTIN: ' + invoice.seller.gstin, 50, y);

  text('Billed to', 330, 730, { size: 9, color: muted });
  text(invoice.buyer_email || 'Customer', 330, 715, { font: bold });

  const top = 600;
  page.drawRectangle({ x: 50, y: top - 6, width: 495, height: 24, color: rgb(0.96, 0.95, 0.99) });
  text('Description', 60, top + 2, { font: bold });
  right('Qty', 400, top + 2, { font: bold });
  right('Amount', 535, top + 2, { font: bold });
  text(invoice.item.length > 70 ? invoice.item.slice(0, 67) + '…' : invoice.item, 60, top - 26);
  right(String(invoice.quantity || 1), 400, top - 26);
  right(rupees(invoice.amount_paise), 535, top - 26);
  page.drawLine({ start: { x: 50, y: top - 44 }, end: { x: 545, y: top - 44 }, thickness: 0.5, color: muted });
  right('Total', 430, top - 66, { font: bold });
  right(rupees(invoice.amount_paise), 535, top - 66, { font: bold, size: 12 });
  right(invoice.seller.gstin ? 'Inclusive of applicable GST' : 'No GST charged (supplier not registered under GST)', 535, top - 84, { size: 9, color: muted });
  if (invoice.discount_pct) right(`Includes a ${invoice.discount_pct}% multi-pass discount`, 535, top - 98, { size: 9, color: muted });

  text('Payment', 50, top - 130, { size: 9, color: muted });
  text(`Paid in full via ${invoice.payment_method || '—'}${invoice.payment_ref ? '  ·  Reference ' + invoice.payment_ref : ''}`, 50, top - 145);
  text('Amount in INR. This is a computer-generated invoice and needs no signature.', 50, 80, { size: 8, color: muted });
  text(`Questions: ${invoice.seller.email}`, 50, 66, { size: 8, color: muted });
  return Buffer.from(await pdf.save());
}
