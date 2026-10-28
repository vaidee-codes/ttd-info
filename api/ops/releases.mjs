import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { countRows, insertOne, selectMany, updateWhere } from '../_ledger.mjs';
import { audit, requireOperator } from '../_ops.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function overview() {
  const since = new Date(Date.now() - 3 * 86400e3).toISOString();
  const [releases, subscribers, unsubscribed] = await Promise.all([
    selectMany('quota_releases', { select: '*', release_at: 'gte.' + since, order: 'release_at.asc', limit: '50' }),
    countRows('reminder_subscribers', { unsubscribed_at: 'is.null' }),
    countRows('reminder_subscribers', { unsubscribed_at: 'not.is.null' })
  ]);
  return { releases, subscribers, unsubscribed };
}

// POST /api/ops/releases
//   { action: 'list' }
//   { action: 'add', date: 'YYYY-MM-DD', time: 'HH:MM' (IST), title }
//   { action: 'cancel', id }
// TTD quota releases for the opt-in reminder emails. Reminders go out the day
// before (from 7 am IST), to subscribers whose pass will have ended by then.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let body;
  let action;
  try {
    body = readJsonBody(req);
    action = boundedString(body.action, { field: 'action', max: 10 });
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    if (action === 'add') {
      let date;
      let time;
      let title;
      try {
        date = boundedString(body.date, { field: 'date', max: 10, pattern: DATE });
        time = boundedString(body.time, { field: 'time', max: 5, pattern: TIME });
        title = boundedString(body.title, { field: 'title', max: 120 });
      } catch (error) {
        return handleRequestError(res, error);
      }
      if (title.length < 3) return sendError(res, 400, 'invalid_request', 'Say what TTD is releasing, e.g. "₹300 darshan for February".');
      const releaseAt = new Date(`${date}T${time}:00+05:30`);
      if (Number.isNaN(releaseAt.getTime())) return sendError(res, 400, 'invalid_request', 'Enter a valid date and time.');
      if (releaseAt.getTime() < Date.now() + 60 * 60e3) return sendError(res, 400, 'invalid_request', 'The release must be at least an hour from now.');
      if (releaseAt.getTime() > Date.now() + 180 * 86400e3) return sendError(res, 400, 'invalid_request', 'The release must be within the next 6 months.');
      const row = await insertOne('quota_releases', { release_at: releaseAt.toISOString(), title, created_by: operator.id });
      await audit(operator, 'quota_release_added', row && row.id, { release_at: releaseAt.toISOString(), title }).catch(() => {});
    } else if (action === 'cancel') {
      const id = String(body.id || '');
      if (!UUID.test(id)) return sendError(res, 400, 'invalid_request', 'Invalid release id.');
      const [row] = await updateWhere('quota_releases', { id, cancelled_at: null }, { cancelled_at: new Date().toISOString() });
      if (!row) return sendError(res, 404, 'not_found', 'Release not found or already cancelled.');
      // Reminders already queued are dropped at send time (the release is cancelled).
      await audit(operator, 'quota_release_cancelled', id, { title: row.title }).catch(() => {});
    } else if (action !== 'list') {
      return sendError(res, 400, 'invalid_request', 'Unknown action.');
    }
    return res.status(200).json({ ok: true, ...await overview() });
  } catch (error) {
    logProviderFailure('ops_releases', error);
    return sendError(res, 503, 'ledger_unavailable', 'The ledger is unavailable. Try again shortly.');
  }
}
