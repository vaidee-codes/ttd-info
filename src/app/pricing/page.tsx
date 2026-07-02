import type { Metadata } from "next";
import Link from "next/link";
import { SERVICE_TIERS } from "@/lib/content";

export const metadata: Metadata = {
  title: "Pricing — Yatra Assist",
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-extrabold text-[var(--color-foreground)] md:text-4xl">
          Simple, itemized pricing
        </h1>
        <p className="mt-4 text-[var(--color-muted)]">
          You always pay the temple/authority its official price directly (or
          it&apos;s reimbursed to us at cost) — our fee is a separate line
          item for the coaching and logistics work we actually do.
        </p>
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {SERVICE_TIERS.map((tier) => (
          <div
            key={tier.id}
            className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm"
          >
            <p className="text-xl font-bold text-[var(--color-primary-dark)]">{tier.name}</p>
            <p className="mt-2 text-2xl font-extrabold text-[var(--color-foreground)]">
              {tier.price}
            </p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">{tier.description}</p>
            <ul className="mt-5 flex-1 space-y-2.5 text-sm text-[var(--color-foreground)]">
              {tier.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-[var(--color-primary)]">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/contact"
              className="mt-6 rounded-full bg-[var(--color-primary)] px-6 py-3 text-center text-sm font-semibold text-white hover:bg-[var(--color-primary-dark)]"
            >
              Request this
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-muted)]">
        <p>
          <strong className="text-[var(--color-foreground)]">Never charged separately:</strong>{" "}
          Sabarimala Virtual Q coupons and Vaishno Devi Yatra Parchi
          registration are free by rule, and we never add a fee to them. Any
          paid help there is limited to genuinely separate services —
          transport, accommodation, helicopter tickets, and on-ground
          coordination.
        </p>
      </div>
    </div>
  );
}
