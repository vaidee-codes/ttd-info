"use client";

import { useState, type FormEvent } from "react";
import { SERVICE_TIERS, TEMPLES } from "@/lib/content";

type Status = "idle" | "submitting" | "success" | "error";

export default function InquiryForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: data.get("name"),
      email: data.get("email"),
      phone: data.get("phone"),
      temple: data.get("temple"),
      tier: data.get("tier"),
      preferred_dates: data.get("preferred_dates"),
      group_size: Number(data.get("group_size")),
      notes: data.get("notes"),
    };

    try {
      const res = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Something went wrong. Please try again.");
      }
      setStatus("success");
      form.reset();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <p className="text-2xl">🙏</p>
        <p className="mt-2 font-semibold text-emerald-800">
          Thank you — we&apos;ve received your inquiry.
        </p>
        <p className="mt-1 text-sm text-emerald-700">
          We&apos;ll reach out by email or phone with next steps and a price
          breakdown.
        </p>
        <button
          onClick={() => setStatus("idle")}
          className="mt-5 rounded-full border border-emerald-300 px-5 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
        >
          Submit another inquiry
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full name" required>
          <input
            name="name"
            type="text"
            required
            maxLength={200}
            className="input"
            placeholder="Your name"
          />
        </Field>
        <Field label="Phone" required>
          <input
            name="phone"
            type="tel"
            required
            maxLength={30}
            className="input"
            placeholder="+91 90000 00000"
          />
        </Field>
      </div>

      <Field label="Email" required>
        <input
          name="email"
          type="email"
          required
          className="input"
          placeholder="you@example.com"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Which temple?" required>
          <select name="temple" required className="input" defaultValue="">
            <option value="" disabled>
              Select a temple
            </option>
            {TEMPLES.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service tier" required>
          <select name="tier" required className="input" defaultValue="">
            <option value="" disabled>
              Select a service
            </option>
            {SERVICE_TIERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.price})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Preferred dates">
          <input
            name="preferred_dates"
            type="text"
            className="input"
            placeholder="e.g. 12–15 Aug 2026"
          />
        </Field>
        <Field label="Group size" required>
          <input
            name="group_size"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            required
            className="input"
          />
        </Field>
      </div>

      <Field label="Anything else we should know?">
        <textarea
          name="notes"
          rows={4}
          maxLength={2000}
          className="input resize-none"
          placeholder="Elderly or differently-abled pilgrims, specific sevas, accessibility needs, etc."
        />
      </Field>

      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded-full bg-[var(--color-primary)] px-6 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:opacity-60"
      >
        {status === "submitting" ? "Submitting…" : "Submit Inquiry"}
      </button>

      <style jsx global>{`
        .input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid var(--color-border);
          background: white;
          padding: 0.65rem 0.9rem;
          font-size: 0.9rem;
          color: var(--color-foreground);
        }
        .input:focus {
          outline: 2px solid var(--color-primary-light);
          outline-offset: 1px;
        }
      `}</style>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--color-foreground)]">
        {label}
        {required && <span className="text-[var(--color-primary)]"> *</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
