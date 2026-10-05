import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { requireOperator } from '../_ops.mjs';
import { buildReport, MAX_CUSTOM_DAYS, MODES, RANGES, resolveRange } from '../_reports.mjs';

const OPERATOR_CACHE_MS = 5 * 60 * 1000;
const REPORT_CACHE_MS = 60 * 1000;
// Recent reports, so repeated clicks on the same range reuse one ledger read.
const reports = new Map();

// POST /api/ops/reports { range, from?, to?, mode?, fresh? } → licence, sales and ops figures.
// range: today | yesterday | 7d | 30d | 90d | month | last_month | fy | all | custom (from/to YYYY-MM-DD, IST).
// mode: live (default) | test | all — which Razorpay orders count. Read-only; ledger only.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res, { cacheMs: OPERATOR_CACHE_MS });
  if (!operator) return;
  let span;
  let mode;
  let fresh;
  try {
    const body = readJsonBody(req);
    const range = boundedString(body.range, { field: 'range', max: 16 });
    mode = boundedString(body.mode, { field: 'mode', max: 8, required: false }) || 'live';
    fresh = body.fresh === true;
    if (!RANGES.includes(range) || !MODES.includes(mode)) return sendError(res, 400, 'invalid_request', 'Unknown report range or mode.');
    span = resolveRange({ range, from: body.from, to: body.to });
    if (!span) return sendError(res, 400, 'invalid_range', `Pick a start and end date (YYYY-MM-DD), end on or after start, at most ${MAX_CUSTOM_DAYS} days apart.`);
  } catch (error) {
    return handleRequestError(res, error);
  }

  // Ranges ending "now" move every request; key them to the minute.
  const cacheKey = [span.key, mode, span.from, span.key === 'custom' || span.key === 'yesterday' || span.key === 'last_month' ? span.to : Math.floor(span.to / REPORT_CACHE_MS)].join('|');
  const cached = reports.get(cacheKey);
  // "Refresh" may skip the cache, but never more than once every 10 seconds.
  const age = cached ? Date.now() - (cached.until - REPORT_CACHE_MS) : Infinity;
  if (cached && (fresh ? age < 10000 : age < REPORT_CACHE_MS)) return res.status(200).json({ ok: true, cached: true, report: cached.report });

  try {
    const report = await buildReport(span, mode);
    if (reports.size > 30) reports.clear();
    reports.set(cacheKey, { report, until: Date.now() + REPORT_CACHE_MS });
    return res.status(200).json({ ok: true, cached: false, report });
  } catch (error) {
    logProviderFailure('ops_reports', error);
    return sendError(res, 503, 'ledger_unavailable', 'Could not read the ledger. Try again shortly.');
  }
}
