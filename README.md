# ⚡ Tirumala Guide & TTD Autofill Assistant Support

**Quick & Easy Form Filling for TTD Booking**

[**Install from the Chrome Web Store →**](https://chromewebstore.google.com/detail/ttd-autofill-assistant/piiegkjdfbbakjmjdckgdjbbohfjfolg)

The independent companion website for TTD Autofill Assistant. It combines practical Tirumala planning guides with extension installation, usage, support and privacy information.

<!-- Personal and family use is free. A paid software-licence pass will be required for professional or client-facing use; professional plans are coming soon. -->

## ✨ Features

- **👥 Pilgrim Booking:** Up to 6 pilgrims with passport and Visa/OCI support.
- **🙏 Srivari Seva:** Individual and group applications, including supported file uploads.
- **🧑‍🤝‍🧑 Group Seva:** Manage and fill up to 15 member profiles.
- **🎟️ Srivani:** Fill up to 4 people into the current-day ticket table.
- **🔒 Local-first:** Profiles are stored in Chrome's local extension storage.

## 📖 Documentation

- **[Home & Installation](index.html):** Planning entry points and the extension overview.
- **[Tirumala Guides](guides.html):** Darshan, booking, stay, travel, walking and temple essentials.
- **[Support & Contact](support.html):** Get help or contact the developer.
- **[Privacy Policy](PRIVACY_POLICY.md):** Local storage, supported data and file handling.
<!--
- **[Terms and Conditions](terms.html):** Personal/family and professional software-licence terms.
- **[Refund and Cancellation Policy](refund-policy.html):** Cancellation and refund terms for future professional plans.
-->

## 🚀 Quick Start

1. **Install:** Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/ttd-autofill-assistant/piiegkjdfbbakjmjdckgdjbbohfjfolg) and click "Add to Chrome".
2. **Setup:** Click the extension icon and add your pilgrim details.
3. **Book:** Go to the TTD booking page and click "Fill All Details".

## ⚠️ Disclaimer

This is an unofficial browser extension and independent website. Neither is affiliated with or endorsed by Tirumala Tirupati Devasthanams (TTD), Reddit, or r/TirumalaDarshan.

TTD Autofill Assistant is an independent browser productivity tool and is not affiliated with or endorsed by TTD. It does not book tickets, bypass CAPTCHA, OTP, queues or payments, and provides no booking guarantee.

## Pass API deployment gate

The public API surface is intentionally limited to:

- `POST /api/checkout`
- `POST /api/license-activate`
- `POST /api/license-refresh`
- `POST /api/license-deactivate`
- `POST /api/license-validate`
- `GET /api/config`

Production and Preview must use separately scoped Vercel variables. Production uses the live Dodo base and live 7-day product/entitlement IDs. Preview uses the Dodo test base, a separate signing private key, disabled sales/gate flags, and only explicitly listed `PASS_PREVIEW_ORIGINS`. Never give Preview the Production signing key.

Both rollout switches fail closed when absent:

- `PASS_SALES_ENABLED=false` prevents checkout creation.
- `PASS_GATE_ENABLED=false` temporarily disables extension enforcement through `/api/config`.

Before enabling sales or deploying Production:

1. Run `npm test` and `vercel build --yes`.
2. Pull Production variables into a temporary ignored file and run `npm run validate:dodo`. It must report INR `9900`, `one_time`, `7` days and `1` activation.
3. Review the staged Vercel Firewall IP/hashed-key rule in log mode. Publish it only after confirming the matches, then move it to enforcement after Preview validation.
4. Verify rejected origins, oversized bodies, invalid keys and removed lookup routes reveal no email, key, activation ID, customer record or provider body.
5. Enable `PASS_SALES_ENABLED` only after every check passes. Keep the switch off for rollback.

API logs contain only operation name and provider status/code. Never add request bodies, email addresses, licence keys, entitlement tokens, activation IDs or complete provider responses to logs.

The sanitized Dodo purchase and entitlement baseline is stored in `ops/dodo-inventory-2026-08-10.json`. It contains no customer, payment, refund or licence-key identifiers.
