import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTtdSsdStatus, OFFICIAL_TTD_STATUS_URL, parseTtdSsdStatus } from '../api/_ttd-ssd.mjs';

const officialHtml = `
  <span id="cph_Home_lblSlotName" style="color: #ff4800;">12</span>
  <span id="cph_Home_lblSlotDate">12-Sep-2026</span>
  <span id="cph_Home_lblAvailableQuota">1,250</span>
`;

test('parses the official SSD slot, India civil date and balance', () => {
  assert.deepEqual(parseTtdSsdStatus(officialHtml), {
    slot: '12',
    darshanDate: '2026-09-12',
    balance: 1250
  });
});

test('accepts an official zero balance without inferring a completion status', () => {
  assert.equal(parseTtdSsdStatus(officialHtml.replace('1,250', '0')).balance, 0);
});

test('fails closed when an official field is missing or malformed', () => {
  assert.throws(() => parseTtdSsdStatus(officialHtml.replace('12-Sep-2026', 'Coming soon')), /missing or malformed/);
  assert.throws(() => parseTtdSsdStatus(officialHtml.replace('1,250', '-5')), /missing or malformed/);
  assert.throws(() => parseTtdSsdStatus('<html></html>'), /missing or malformed/);
});

test('fetches only the fixed official page and returns a timestamped contract', async () => {
  const calls = [];
  const result = await fetchTtdSsdStatus({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => officialHtml };
    },
    now: () => new Date('2026-09-11T05:30:00.000Z')
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OFFICIAL_TTD_STATUS_URL);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'official-ttd');
  assert.equal(result.checkedAt, '2026-09-11T05:30:00.000Z');
});
