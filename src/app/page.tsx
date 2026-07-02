import Link from "next/link";
import { SERVICE_TIERS, TEMPLES } from "@/lib/content";

export default function Home() {
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-b from-[var(--color-tint)] to-[var(--background)]">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <div className="max-w-2xl">
            <span className="inline-block rounded-full bg-white px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-primary-dark)] shadow-sm">
              Pilgrimage Booking Concierge
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight text-[var(--color-foreground)] md:text-5xl">
              We help you get the darshan slot.
              <br />
              <span className="text-[var(--color-primary)]">You stay in control of the booking.</span>
            </h1>
            <p className="mt-5 text-lg text-[var(--color-muted)]">
              Yatra Assist coaches you through official TTD, Sabarimala,
              Vaishno Devi, Shirdi and Kashi Vishwanath booking portals in
              real time, and handles the travel logistics around your visit —
              at the official ticket price, always.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/contact"
                className="rounded-full bg-[var(--color-primary)] px-7 py-3.5 text-sm font-semibold text-white shadow-md transition-transform hover:-translate-y-0.5 hover:bg-[var(--color-primary-dark)]"
              >
                Request Assistance
              </Link>
              <Link
                href="/how-it-works"
                className="rounded-full border border-[var(--color-border)] bg-white px-7 py-3.5 text-sm font-semibold text-[var(--color-primary-dark)] transition-colors hover:border-[var(--color-primary)]"
              >
                See how it works
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          <PrincipleCard
            icon="🔑"
            title="You keep your login"
            body="You always submit your own booking with your own credentials — we coach, we never take over your account."
          />
          <PrincipleCard
            icon="🧾"
            title="Official price, always"
            body="Darshan/seva ticket costs are passed through at face value, itemized separately from our service fee."
          />
          <PrincipleCard
            icon="🚫"
            title="No standalone Srivani/Sabarimala booking"
            body="These are offered only as free add-ons inside full logistics packages, in line with each authority's stated rules."
          />
        </div>
      </section>

      <section className="bg-[var(--color-tint)] py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-end justify-between">
            <h2 className="text-2xl font-bold text-[var(--color-foreground)]">
              Temples we support
            </h2>
            <Link href="/services" className="text-sm font-semibold text-[var(--color-primary-dark)] hover:underline">
              View all &rarr;
            </Link>
          </div>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TEMPLES.slice(0, 6).map((t) => (
              <div key={t.slug} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
                <p className="font-semibold text-[var(--color-foreground)]">{t.name}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">{t.location}</p>
                <p className="mt-3 text-sm text-[var(--color-primary-dark)]">{t.officialFee}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold text-[var(--color-foreground)]">
          Two ways to work with us
        </h2>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {SERVICE_TIERS.map((tier) => (
            <div key={tier.id} className="rounded-2xl border border-[var(--color-border)] bg-white p-7 shadow-sm">
              <p className="text-lg font-bold text-[var(--color-primary-dark)]">{tier.name}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--color-accent)]">{tier.price}</p>
              <p className="mt-3 text-sm text-[var(--color-muted)]">{tier.description}</p>
              <ul className="mt-4 space-y-2 text-sm text-[var(--color-foreground)]">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-[var(--color-primary)]">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="rounded-3xl bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-dark)] px-8 py-14 text-center text-white">
          <h2 className="text-2xl font-bold md:text-3xl">Ready to plan your visit?</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/90">
            Tell us where you want to go and when — we&apos;ll get back to you
            with a plan and a transparent price breakdown.
          </p>
          <Link
            href="/contact"
            className="mt-7 inline-block rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-[var(--color-primary-dark)] shadow-md transition-transform hover:-translate-y-0.5"
          >
            Submit an Inquiry
          </Link>
        </div>
      </section>
    </div>
  );
}

function PrincipleCard({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm">
      <span className="text-2xl">{icon}</span>
      <p className="mt-3 font-semibold text-[var(--color-foreground)]">{title}</p>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
