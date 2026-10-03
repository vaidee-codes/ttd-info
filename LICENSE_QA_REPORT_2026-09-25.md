# Licence activation QA — production retest, 25 September 2026

Scope: 7.5.1 extension source, production deployment `dpl_3szXyGDwyK61CDZYkbGY1Uwv7q3X` at `https://ttd-info.vercel.app`, and live Dodo licence endpoints. The deployment included only backend API/config changes; pending pass-page and support-page edits were excluded. Payments and checkout creation were stubbed. No charge or refund was made.

## Release findings

1. **The original activation failure is resolved in production.** A retry from the same installation returned 200 with the original instance; another installation received `409 activation_in_use` and did not take the slot. A recent activation from an older no-marker build also reattached using its matching device label.
2. **Deactivation now has a terminal validation result.** Dodo returns 404 for a removed instance. Production `/api/license-validate` now returns `200 {ok:true,valid:false}`, while refresh returns `401 licence_invalid`. The prior production response was `502 provider_unavailable`.
3. **Expired imported keys needed an additional error fix.** Dodo can briefly activate a key whose `expires_at` is in the past, then return `valid:false`. The backend now checks the authenticated key record's expiry before assigning the generic validation error, releases the reserved slot, and returns `400 licence_expired`. A fresh renewal key activated successfully afterward. Disabled keys were rejected as `licence_inactive`.
4. **Migration risk: recovery depends on a deprecated listing API.** The handler searches at most five 100-key pages to find a spent key before matching its instance. Dodo marks `GET /license_keys` deprecated. A key outside those pages, or removal of that API, cannot be recovered by this path. Preserve an indexed key-to-instance lookup when migrating providers.

## Real API evidence

Twenty manual licence keys were created across the initial QA and deployment retests for `vaidee@test.com` on the live weekly product. A final provider audit verified that all 20 were disabled with zero active instances. No customer key or payment was touched.

| Path | Result |
| --- | --- |
| Dodo create, get, list instances, activate, validate, deactivate, reactivate | Passed. Second activation returned HTTP 422 `LICENSE_KEY_LIMIT_REACHED`; deactivation invalidated and freed the slot. |
| Production activation against live Dodo | First activation 200; same-install retry 200 with the same instance; different installation 409 without moving the slot. |
| Recent pre-marker activation | Same device label reattached in production; different label was refused. |
| Old expired key followed by new purchase key | Expired key returned `licence_expired`, with no active instance left behind; new key activated. |
| Disabled key | Refused as inactive. |
| Production validate, refresh, deactivate | Active validate and refresh passed; wrong installation was 401; deactivation passed; validation after deactivation returned `valid:false`; refresh after deactivation returned terminal 401; reactivation worked. |
| Extension signature and worker | A real deployed entitlement passed the current extension's cryptographic verification and worker authorization. A changed installation binding failed. This was run with a simulated Chrome storage/runtime, without modifying the installed extension. |
| Live product configuration | 7, 30, and 90-day product/entitlement configuration guards passed. |

## Automated migration baseline

Run `npm test` in this repository and `npm test -- --run` in `autofill-extension` before changing a payment provider. Current results: **77 backend tests** and **286 extension tests**, all passing.

The backend contract tests cover successful domestic and foreign payments, processing/failed/refunded payments, payment identity mismatch, manually issued keys with no payment, disabled and expired keys, wrong products, failed provider validation, missing instances, token binding, activation 403/404, checkout configuration, rate limits, CORS, request validation, same-install recovery, other-install refusal, legacy recovery, timeout recovery, and pass-page handoff/retries. The extension tests cover signed entitlement enforcement, error and support actions, timeouts, network failures, malformed responses, renewal retries, old/new pass storage races, external message origin checks, and deactivation behavior.

## Limits and release gate

The paid checkout path was exercised with stubs, as requested; no real payment, refund, chargeback, webhook delivery, or bank settlement was performed. The pass success page was run in a simulated DOM, and the extension worker was run in simulated Chrome APIs; an installed-Chrome UI smoke test remains useful before store submission. A real production-signed token was verified by the current extension source, with a changed installation binding rejected. Tests using temporary live keys and tokens were removed so CI does not depend on secrets or expiring data.

Backend deployment is complete and the production retest passed. The 7.5.1 extension has not been submitted or distributed. The backend source remains uncommitted in the working tree, so commit the deployed API/config changes before future deployments or branch changes. Vercel inspection reports the production deployment Ready, and an error-level log query for its first hour returned no logs.

Dodo reference: https://docs.dodopayments.com/api-reference/licenses/list-license-keys
