# Yatra Assist

A pilgrimage booking **concierge** website: a marketing site plus a small
webapp for handling customer inquiries. Built with Next.js (App Router),
TypeScript, Tailwind CSS, and a local SQLite database (via `better-sqlite3`)
— no external services required to run it.

Full business rationale (legal landscape per temple, pricing model, phased
rollout) lives in the plan this was built from:
`/root/.claude/plans/i-want-to-build-quizzical-narwhal.md`.

## What's here

- **Marketing site** — `/`, `/services`, `/how-it-works`, `/pricing`, `/trust`
  explain the concierge model: customers always submit their own booking with
  their own login; Yatra Assist charges a separate coaching/logistics fee,
  never a markup on the official ticket price.
- **Inquiry intake** — `/contact` has a form that customers submit (temple,
  service tier, dates, group size, notes). Stored in SQLite via
  `POST /api/inquiries`.
- **Admin dashboard** — `/admin` (password-protected login) → `/admin/dashboard`
  lists all inquiries and lets you update their status
  (new → contacted → in_progress → completed).

## Running it locally

```bash
npm install
cp .env.example .env.local   # then edit ADMIN_PASSWORD and AUTH_SECRET
npm run dev
```

Open http://localhost:3000 for the site, and http://localhost:3000/admin to
sign in to the dashboard with the password you set in `.env.local`.

The SQLite database file is created automatically at `data/yatra-assist.db`
on first run (git-ignored).

## Content model

Temple list, per-temple risk notes, and service tiers are defined in one
place: `src/lib/content.ts`. Add a temple or change pricing there and it
updates the homepage, `/services`, `/pricing`, and the inquiry form
automatically.

## What this is **not** (yet)

This is a working MVP for taking and managing inquiries — it is **not** a
production business. Before actually operating:

1. **Payment collection** — no payment gateway is integrated. You'll need a
   registered payment processor (Razorpay/PayU/etc.) once you're ready to
   charge the service fee described in `/pricing`.
2. **Business registration** — the legal/compliance notes on `/trust` reflect
   research done during planning, not legal advice. Register the business
   appropriately and consider a lawyer's review of the terms of service
   before taking real customer money, especially given the touting-related
   enforcement history around TTD Srivani and Sabarimala bookings.
3. **Notifications** — inquiry submissions are only visible in the admin
   dashboard right now; there's no email/SMS alert wired up yet.
4. **IRCTC** — intentionally out of scope. Only add it after pursuing
   IRCTC's official Authorized Agent program, per the plan.
5. **Deployment** — this runs locally with a file-based SQLite DB. For a
   real deployment you'll want a persistent volume (or swap in a hosted DB)
   and to set `ADMIN_PASSWORD`/`AUTH_SECRET` to real secrets, not the
   `.env.example` placeholders.
