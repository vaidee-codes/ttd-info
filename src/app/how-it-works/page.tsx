import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How It Works — Yatra Assist",
};

const STEPS = [
  {
    step: "1",
    title: "You reach out",
    body: "Submit an inquiry with your temple, preferred dates, and group size. We only ever act after you approach us — we don't cold-book or resell tickets to anyone.",
  },
  {
    step: "2",
    title: "We prepare you",
    body: "We review your ID documents and pilgrim details ahead of time, and tell you exactly when the booking window opens for your chosen temple.",
  },
  {
    step: "3",
    title: "We coach you live",
    body: "During the booking window, we stay on a call or chat with you while you log in with your own credentials and complete the booking yourself, step by step.",
  },
  {
    step: "4",
    title: "We handle the trip",
    body: "If you've booked a logistics package, we arrange transport, accommodation, and on-ground coordination around your confirmed slot.",
  },
  {
    step: "5",
    title: "You get an itemized bill",
    body: "The official ticket/donation cost is always shown separately from our coaching or logistics fee — no bundling, no markup on the government price.",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-3xl font-extrabold text-[var(--color-foreground)] md:text-4xl">
        How it works
      </h1>
      <p className="mt-4 text-[var(--color-muted)]">
        We built Yatra Assist around one boundary: you always keep custody of
        your own booking. Here&apos;s what that looks like in practice.
      </p>

      <ol className="mt-10 space-y-8 border-l-2 border-[var(--color-border)] pl-8">
        {STEPS.map((s) => (
          <li key={s.step} className="relative">
            <span className="absolute -left-[41px] flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-bold text-white">
              {s.step}
            </span>
            <p className="font-semibold text-[var(--color-foreground)]">{s.title}</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-12 rounded-2xl border border-[var(--color-border)] bg-[var(--color-tint)] p-6">
        <p className="font-semibold text-[var(--color-foreground)]">
          What we will never do
        </p>
        <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
          <li>• Log into an official portal on your behalf and submit a booking for you</li>
          <li>• Buy and resell tickets on a secondary market</li>
          <li>• Charge a fee for Sabarimala Virtual Q or Vaishno Devi Yatra Parchi registration, which are free by rule</li>
          <li>• Sell Srivani booking as a standalone paid service</li>
        </ul>
      </div>

      <div className="mt-10 text-center">
        <Link
          href="/contact"
          className="inline-block rounded-full bg-[var(--color-primary)] px-7 py-3.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-dark)]"
        >
          Start an Inquiry
        </Link>
      </div>
    </div>
  );
}
