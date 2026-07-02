import type { Metadata } from "next";
import InquiryForm from "@/components/InquiryForm";

export const metadata: Metadata = {
  title: "Request Assistance — Yatra Assist",
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-extrabold text-[var(--color-foreground)] md:text-4xl">
        Request assistance
      </h1>
      <p className="mt-4 text-[var(--color-muted)]">
        Tell us about your visit and we&apos;ll get back to you with a plan
        and a transparent, itemized price. We only start work after you
        reach out to us.
      </p>

      <div className="mt-10 rounded-2xl border border-[var(--color-border)] bg-white p-7 shadow-sm">
        <InquiryForm />
      </div>
    </div>
  );
}
