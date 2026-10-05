import { PLANS } from './_dodo.mjs';
import { countRows, selectAll } from './_ledger.mjs';

// Operations reports. Read-only, and built from the ledger alone: Keygen (the
// one-worker VPS that serves every refresh) is never queried. Every licence
// issued since the cutover has a ledger row — Razorpay orders and offline
// sales/grants — so the ledger is the complete record of new licences.

const IST_MS = 330 * 60 * 1000; // India has no daylight saving: always UTC+5:30
const DAY_MS = 86400000;
export const MAX_CUSTOM_DAYS = 400;
// The ledger starts with the Razorpay/Keygen build (Sept 2026), so "all time"
// is everything from the start of that financial year.
const ALL_TIME_START = Date.UTC(2026, 3, 1) - IST_MS;
export const RANGES = ['today', 'yesterday', '7d', '30d', '90d', 'month', 'last_month', 'fy', 'all', 'custom'];
export const MODES = ['live', 'test', 'all'];

const istParts = (ms) => {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours() };
};
const istMs = (y, m, d = 1) => Date.UTC(y, m, d) - IST_MS;
const istMidnight = (ms) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
const pad = (n) => String(n).padStart(2, '0');
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value) {
  const m = DATE.exec(String(value || ''));
  if (!m) return null;
  const ms = istMs(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = istParts(ms);
  return back.y === Number(m[1]) && back.m === Number(m[2]) - 1 && back.d === Number(m[3]) ? ms : null;
}

// Returns { key, from, to, bucket } (from inclusive, to exclusive, epoch ms),
// or null when the request is not a valid range.
export function resolveRange({ range, from, to } = {}, now = Date.now()) {
  const today = istMidnight(now);
  const p = istParts(now);
  const fyStartYear = p.m >= 3 ? p.y : p.y - 1;
  const spans = {
    today: [today, now],
    yesterday: [today - DAY_MS, today],
    '7d': [today - 6 * DAY_MS, now],
    '30d': [today - 29 * DAY_MS, now],
    '90d': [today - 89 * DAY_MS, now],
    month: [istMs(p.y, p.m), now],
    last_month: [istMs(p.y, p.m - 1), istMs(p.y, p.m)],
    fy: [istMs(fyStartYear, 3), now],
    all: [Math.min(ALL_TIME_START, now), now]
  };
  let span = spans[range];
  if (range === 'custom') {
    const start = parseDate(from);
    const endDay = parseDate(to);
    if (start === null || endDay === null || endDay < start) return null;
    if ((endDay - start) / DAY_MS + 1 > MAX_CUSTOM_DAYS) return null;
    span = [start, Math.min(endDay + DAY_MS, Math.max(now, start))];
  }
  if (!span) return null;
  const days = (span[1] - span[0]) / DAY_MS;
  return { key: range, from: span[0], to: span[1], bucket: days <= 1 ? 'hour' : days <= 92 ? 'day' : 'month' };
}

export function bucketOf(ms, bucket) {
  const p = istParts(ms);
  const day = `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
  if (bucket === 'hour') return `${day} ${pad(p.h)}:00`;
  if (bucket === 'day') return day;
  return `${p.y}-${pad(p.m + 1)}`;
}

// Every bucket in [from, to), so the chart shows quiet periods as zero.
export function bucketsBetween(from, to, bucket) {
  const keys = [];
  let ms = bucket === 'hour' ? Math.floor((from + IST_MS) / 3600000) * 3600000 - IST_MS : bucket === 'day' ? istMidnight(from) : (() => { const p = istParts(from); return istMs(p.y, p.m); })();
  while (ms < to && keys.length < 1000) {
    keys.push(bucketOf(ms, bucket));
    if (bucket === 'hour') ms += 3600000;
    else if (bucket === 'day') ms += DAY_MS;
    else { const p = istParts(ms); ms = istMs(p.y, p.m + 1); }
  }
  return keys;
}

const between = (column, from, to) => [[column, 'gte.' + new Date(from).toISOString()], [column, 'lt.' + new Date(to).toISOString()]];
const modeFilter = (mode) => mode === 'live' ? [['razorpay_mode', 'eq.live']] : mode === 'test' ? [['razorpay_mode', 'neq.live']] : [];
const planLabel = (plan) => (PLANS[plan] && PLANS[plan].label) || plan || 'unknown';

// Reads the ledger one query at a time (never in parallel), so a report holds
// at most one ledger connection and checkout/refresh traffic is unaffected.
export async function buildReport(span, mode) {
  const truncated = [];
  const read = async (table, query, order) => {
    const result = await selectAll(table, query, { order });
    if (result.truncated) truncated.push(table);
    return result.rows;
  };

  const paid = await read('orders', [['select', 'id,plan,amount_paise,quantity,discount_pct,status,razorpay_mode,paid_at,email'],
    ...between('paid_at', span.from, span.to), ['status', 'in.(paid,fulfilled)'], ...modeFilter(mode)], 'paid_at.asc,id.asc');
  const started = await read('orders', [['select', 'status,created_at'], ...between('created_at', span.from, span.to), ...modeFilter(mode)], 'created_at.asc,id.asc');
  const offline = await read('offline_sales', [['select', 'id,kind,method,plan,amount_inr,activations,email,reference,created_at'],
    ...between('created_at', span.from, span.to), ['status', 'eq.provisioned']], 'created_at.asc,id.asc');
  const emails = await read('email_outbox', [['select', 'status,kind,provider'], ...between('created_at', span.from, span.to)], 'created_at.asc,id.asc');
  const audits = await read('audit_events', [['select', 'action'], ...between('at', span.from, span.to)], 'at.asc,id.asc');
  const invoicesIssued = await countRows('invoices', between('issued_at', span.from, span.to));
  const emailBacklog = await countRows('email_outbox', [['status', 'eq.queued']]);
  const onRecord = await read('licence_authority', [['select', 'source'], ['source', 'neq.dodo-migrated']], 'key_hash.asc');
  const dodoMigrated = await countRows('licence_authority', [['source', 'eq.dodo-migrated']]);

  const seriesKeys = bucketsBetween(span.from, span.to, span.bucket);
  const series = new Map(seriesKeys.map((k) => [k, { bucket: k, razorpay: 0, offline: 0, grant: 0, revenue_paise: 0 }]));
  const point = (ts) => series.get(bucketOf(Date.parse(ts), span.bucket));
  const plans = {};
  const planRow = (plan) => (plans[plan] ||= { plan, label: planLabel(plan), licences: 0, passes: 0, revenue_paise: 0 });
  const licences = [];

  for (const o of paid) {
    const quantity = Number(o.quantity || 1);
    const amount = Number(o.amount_paise || 0);
    const row = planRow(o.plan);
    row.licences += 1; row.passes += quantity; row.revenue_paise += amount;
    const pt = point(o.paid_at);
    if (pt) { pt.razorpay += 1; pt.revenue_paise += amount; }
    licences.push({ at: o.paid_at, source: 'razorpay', plan: o.plan, passes: quantity, amount_paise: amount, email: o.email || null,
      detail: [o.discount_pct ? o.discount_pct + '% bulk discount' : '', o.status === 'paid' ? 'licence pending' : '', o.razorpay_mode !== 'live' ? 'test mode' : '']
        .filter(Boolean).join(' · ') });
  }
  for (const s of offline) {
    const passes = Number(s.activations || 1);
    const amount = s.kind === 'paid' ? Number(s.amount_inr || 0) * 100 : 0;
    const row = planRow(s.plan);
    row.licences += 1; row.passes += passes; row.revenue_paise += amount;
    const pt = point(s.created_at);
    if (pt) { pt[s.kind === 'grant' ? 'grant' : 'offline'] += 1; pt.revenue_paise += amount; }
    licences.push({ at: s.created_at, source: s.kind === 'grant' ? 'grant' : 'offline', plan: s.plan, passes, amount_paise: amount,
      email: s.email || null, detail: [s.method.toUpperCase(), s.reference].filter(Boolean).join(' · ') });
  }
  licences.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
  const paidOffline = offline.filter((s) => s.kind === 'paid');
  const grants = offline.filter((s) => s.kind === 'grant');
  const razorpayRevenue = sum(paid, (o) => Number(o.amount_paise || 0));
  const offlineRevenue = sum(paidOffline, (s) => Number(s.amount_inr || 0) * 100);
  const countBy = (rows, f) => Object.entries(rows.reduce((acc, r) => { const k = f(r) || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))
    .map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  const completed = started.filter((o) => o.status !== 'created').length;

  return {
    range: { key: span.key, from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), bucket: span.bucket },
    mode,
    generated_at: new Date().toISOString(),
    licences: {
      total: paid.length + offline.length,
      razorpay: paid.length,
      offline: paidOffline.length,
      grant: grants.length,
      passes: sum(paid, (o) => Number(o.quantity || 1)) + sum(offline, (s) => Number(s.activations || 1)),
      multi_pass: paid.filter((o) => Number(o.quantity || 1) > 1).length + offline.filter((s) => Number(s.activations || 1) > 1).length,
      awaiting_licence: paid.filter((o) => o.status === 'paid').length
    },
    revenue: {
      total_paise: razorpayRevenue + offlineRevenue,
      razorpay_paise: razorpayRevenue,
      offline_paise: offlineRevenue,
      average_order_paise: paid.length ? Math.round(razorpayRevenue / paid.length) : 0
    },
    checkouts: { started: started.length, completed, abandoned: started.length - completed },
    plans: Object.values(plans).sort((a, b) => (PLANS[a.plan] ? PLANS[a.plan].days : 1e9) - (PLANS[b.plan] ? PLANS[b.plan].days : 1e9)),
    offline_methods: countBy(paidOffline, (s) => s.method),
    emails: { by_status: countBy(emails, (e) => e.status), by_provider: countBy(emails.filter((e) => e.status === 'sent'), (e) => e.provider), queued_now: emailBacklog },
    invoices_issued: invoicesIssued,
    ops_activity: countBy(audits, (a) => a.action),
    on_record: { dodo_migrated: dodoMigrated, ...Object.fromEntries(countBy(onRecord, (r) => r.source).map((x) => [x.key, x.count])) },
    series: [...series.values()],
    recent: licences,
    truncated
  };
}
