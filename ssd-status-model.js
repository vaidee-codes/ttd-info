export const MAX_STATUS_AGE_MS = 7 * 60 * 1000;
export function statusFreshness(data, now = Date.now()) {
  const checked = typeof data?.checkedAt === 'string' ? Date.parse(data.checkedAt) : NaN;
  if (!Number.isFinite(checked) || checked > now + 60_000) return 'invalid';
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  return now - checked > MAX_STATUS_AGE_MS || data.darshanDate < today ? 'stale' : 'fresh';
}
