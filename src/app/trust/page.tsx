import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trust & Legal — Yatra Assist",
};

export default function TrustPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-extrabold text-[var(--color-foreground)] md:text-4xl">
        Trust &amp; legal
      </h1>
      <p className="mt-4 text-[var(--color-muted)]">
        Temple and pilgrimage booking systems exist to serve devotees
        directly, and several authorities have taken action against
        third parties who charge for facilitating bookings. Here is exactly
        where we draw the line, and why.
      </p>

      <div className="mt-10 space-y-8">
        <Principle
          title="We are not a ticket reseller"
          body="We never buy darshan or seva tickets in advance and sell them on. Every booking we assist with is initiated by a customer who has already approached us, for that customer's own visit."
        />
        <Principle
          title="You always hold the login"
          body="For every booking, you log in with your own credentials and personal identification, and you click submit. We coach and prepare you — we do not take over accounts to book on your behalf."
        />
        <Principle
          title="Official price, itemized separately"
          body="Ticket and donation costs are always shown as their own line item, matching the temple's published price. Our fee is a separate, clearly labeled charge for coaching, document preparation, and logistics."
        />
        <Principle
          title="We follow each authority's stated position"
          body="TTD has publicly investigated paid facilitation of Srivani bookings; the Travancore Devaswom Board has stated no agent is authorized to charge for Sabarimala Virtual Q coupons, which are free. We do not sell paid booking services where an authority has said not to — full stop, regardless of whether it's technically possible."
        />
        <Principle
          title="Independent, unaffiliated"
          body="Yatra Assist is an independent service. We are not affiliated with, endorsed by, or connected to TTD, the Travancore Devaswom Board, the Shri Mata Vaishno Devi Shrine Board, Shirdi Sai Baba Sansthan Trust, the Kashi Vishwanath Temple, or any other temple authority."
        />
      </div>

      <div className="mt-12 rounded-2xl border border-[var(--color-border)] bg-[var(--color-tint)] p-6 text-sm text-[var(--color-muted)]">
        <p className="font-semibold text-[var(--color-foreground)]">A note on IRCTC / train tickets</p>
        <p className="mt-2">
          We do not currently offer train ticket booking assistance. IRCTC
          reserves booking-on-behalf-of-customers for its official Authorized
          Agent program, separate from personal retail accounts. We&apos;ll
          only offer this once we&apos;ve gone through that registration
          process.
        </p>
      </div>
    </div>
  );
}

function Principle({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="font-semibold text-[var(--color-foreground)]">{title}</p>
      <p className="mt-1.5 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
