export const OFFICIAL_TTD_STATUS_URL = 'https://www.tirumala.org/Home.aspx';

const FIELD_IDS = {
  slot: 'cph_Home_lblSlotName',
  darshanDate: 'cph_Home_lblSlotDate',
  balance: 'cph_Home_lblAvailableQuota'
};

const MONTHS = new Map([
  ['jan', '01'], ['feb', '02'], ['mar', '03'], ['apr', '04'],
  ['may', '05'], ['jun', '06'], ['jul', '07'], ['aug', '08'],
  ['sep', '09'], ['oct', '10'], ['nov', '11'], ['dec', '12']
]);

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldText(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<span\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return match ? decodeHtml(match[1]) : null;
}

function parseOfficialDate(value) {
  const match = value?.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  const day = Number(match[1]);
  if (!month || day < 1 || day > 31) return null;
  const iso = `${match[3]}-${month}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

function parseBalance(value) {
  if (!value || !/^[\d,\s]+$/.test(value)) return null;
  const balance = Number(value.replace(/[\s,]/g, ''));
  return Number.isSafeInteger(balance) && balance >= 0 && balance <= 1_000_000 ? balance : null;
}

export function parseTtdSsdStatus(html) {
  if (typeof html !== 'string' || html.length === 0) throw new Error('Official TTD response was empty');
  const slot = fieldText(html, FIELD_IDS.slot);
  const darshanDate = parseOfficialDate(fieldText(html, FIELD_IDS.darshanDate));
  const balance = parseBalance(fieldText(html, FIELD_IDS.balance));
  if (!slot || slot.length > 80 || !darshanDate || balance === null) {
    throw new Error('Official TTD SSD fields were missing or malformed');
  }
  return { slot, darshanDate, balance };
}

export async function fetchTtdSsdStatus({ fetchImpl = fetch, now = () => new Date(), timeoutMs = 7000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OFFICIAL_TTD_STATUS_URL, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'TTD-Info/1.0 (+https://ttd-info.vercel.app/tokens)'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Official TTD returned HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > 1_000_000) throw new Error('Official TTD response exceeded the expected size');
    return {
      source: 'official-ttd',
      sourceUrl: OFFICIAL_TTD_STATUS_URL,
      status: 'ok',
      ...parseTtdSsdStatus(html),
      checkedAt: now().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}
