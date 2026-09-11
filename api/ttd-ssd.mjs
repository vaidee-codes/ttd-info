import { fetchTtdSsdStatus, OFFICIAL_TTD_STATUS_URL } from './_ttd-ssd.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'unavailable', reason: 'method_not_allowed' });
  }

  try {
    const status = await fetchTtdSsdStatus();
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    return res.status(200).json(status);
  } catch (error) {
    console.error('Official TTD SSD status fetch failed', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      source: 'official-ttd',
      sourceUrl: OFFICIAL_TTD_STATUS_URL,
      status: 'unavailable',
      reason: 'official_source_unavailable',
      checkedAt: new Date().toISOString()
    });
  }
}
