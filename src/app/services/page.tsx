import type { Metadata } from "next";
import Link from "next/link";
import { TEMPLES } from "@/lib/content";

export const metadata: Metadata = {
  title: "Temples We Support — Yatra Assist",
};

const RISK_STYLES: Record<string, string> = {
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-rose-50 text-rose-700 border-rose-200",
};

const RISK_LABEL: Record<string, string> = {
  low: "Standard assistance",
  medium: "Coaching only — you submit",
  high: "Free add-on only",
};

export default function ServicesPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-extrabold text-[var(--color-foreground)] md:text-4xl">
          Temples we support
        </h1>
        <p className="mt-4 text-[var(--color-muted)]">
          Every temple has its own official booking system and its own rules
          about third-party assistance. We match how we help to each
          authority&apos;s stated rules, not just to what&apos;s technically
          possible.
        </p>
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {TEMPLES.map((t) => (
          <div key={t.slug} className="rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-bold text-[var(--color-foreground)]">{t.name}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">{t.location}</p>
              </div>
              <span
                className={`shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold ${RISK_STYLES[t.riskLevel]}`}
              >
                {RISK_LABEL[t.riskLevel]}
              </span>
            </div>

            <p className="mt-3 text-sm text-[var(--color-muted)]">{t.blurb}</p>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--color-muted)]">Official cost</dt>
                <dd className="text-right font-semibold text-[var(--color-primary-dark)]">
                  {t.officialFee}
                </dd>
              </div>
            </dl>

            <p className="mt-4 rounded-xl bg-[var(--color-tint)] p-3 text-xs text-[var(--color-foreground)]">
              {t.riskNote}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-12 rounded-2xl border border-[var(--color-border)] bg-[var(--color-tint)] p-6 text-center">
        <p className="font-semibold text-[var(--color-foreground)]">
          Don&apos;t see your temple listed?
        </p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Tell us where you&apos;re headed — we&apos;ll let you know honestly
          whether we can help.
        </p>
        <Link
          href="/contact"
          className="mt-4 inline-block rounded-full bg-[var(--color-primary)] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-dark)]"
        >
          Ask us
        </Link>
      </div>
    </div>
  );
}
