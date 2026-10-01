import { logProviderFailure } from './_dodo.mjs';
import { sendEmail } from './_email.mjs';
import { createChallenge, hasPurchases, keysForEmail, MAX_CHALLENGES_PER_HOUR, newCode, recentChallengeCount, verifyChallenge } from './_find-key.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from './_http.mjs';
import { normaliseEmail } from './_payments.mjs';
import { enforceHashedKeyRateLimit } from './_rate-limit.mjs';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CODE = /^\d{6}$/;
const SENT = 'If that email has a TTD Autofill purchase, a 6-digit code is on its way. It expires in 10 minutes.';

// POST /api/find-key { email }              → emails a one-time code (same answer either way)
// POST /api/find-key { email, code }        → the licence keys bought with that email
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  let email;
  let code;
  try {
    const body = readJsonBody(req);
    email = normaliseEmail(boundedString(body.email, { field: 'email', max: 254, pattern: EMAIL }));
    code = boundedString(body.code, { field: 'code', max: 6, pattern: CODE, required: false });
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (!await enforceHashedKeyRateLimit(req, res, 'find-key:' + email)) return;

  try {
    if (!code) {
      if (await recentChallengeCount(email) >= MAX_CHALLENGES_PER_HOUR) return res.status(200).json({ ok: true, message: SENT });
      if (await hasPurchases(email)) {
        const challengeCode = newCode();
        await createChallenge(email, challengeCode);
        await sendEmail({
          to: email,
          subject: `Your TTD Autofill code: ${challengeCode}`,
          text: `Your code to see your TTD Autofill licence keys is ${challengeCode}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.\n\nCrimson\nTTD Autofill`,
          html: `<p>Your code to see your TTD Autofill licence keys is</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${challengeCode}</p><p>It expires in 10 minutes. If you did not ask for this, ignore this email.</p><p>Crimson<br>TTD Autofill</p>`,
          idempotencyKey: `find-key/${challengeCode}/${email}`
        });
      }
      return res.status(200).json({ ok: true, message: SENT });
    }
    if (!await verifyChallenge(email, code)) {
      return sendError(res, 400, 'invalid_code', 'That code is wrong or has expired. Request a new one.');
    }
    return res.status(200).json({ ok: true, keys: await keysForEmail(email) });
  } catch (error) {
    logProviderFailure('find_key', error);
    return sendError(res, 503, 'temporarily_unavailable', 'This is temporarily unavailable. Try again shortly.');
  }
}
