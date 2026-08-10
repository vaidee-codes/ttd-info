import { cors } from './_dodo.mjs';

// The route remains as an explicit tombstone so older clients fail closed.
export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  return res.status(410).json({
    code: 'EMAIL_LOOKUP_DISABLED',
    error: 'Email licence lookup is disabled. Paste your licence key instead.'
  });
}
