"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Inquiry } from "@/lib/inquiry-types";
import { INQUIRY_STATUSES } from "@/lib/inquiry-types";
import { TEMPLES, SERVICE_TIERS } from "@/lib/content";

const STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-50 text-blue-700 border-blue-200",
  contacted: "bg-amber-50 text-amber-700 border-amber-200",
  in_progress: "bg-purple-50 text-purple-700 border-purple-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

function templeName(slug: string) {
  return TEMPLES.find((t) => t.slug === slug)?.name ?? slug;
}

function tierName(id: string) {
  return SERVICE_TIERS.find((t) => t.id === id)?.name ?? id;
}

export default function InquiriesTable({ initial }: { initial: Inquiry[] }) {
  const [inquiries, setInquiries] = useState(initial);
  const [updating, setUpdating] = useState<number | null>(null);
  const router = useRouter();

  async function updateStatus(id: number, status: string) {
    setUpdating(id);
    try {
      const res = await fetch(`/api/inquiries/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        const { inquiry } = await res.json();
        setInquiries((prev) => prev.map((i) => (i.id === id ? inquiry : i)));
      }
    } finally {
      setUpdating(null);
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin");
    router.refresh();
  }

  if (inquiries.length === 0) {
    return (
      <div>
        <TopBar onLogout={logout} />
        <p className="mt-10 text-center text-sm text-[var(--color-muted)]">
          No inquiries yet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <TopBar onLogout={logout} />
      <div className="mt-6 overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-tint)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Temple</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Dates</th>
              <th className="px-4 py-3">Group</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {inquiries.map((inq) => (
              <tr key={inq.id} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-4 py-3 whitespace-nowrap text-[var(--color-muted)]">
                  {new Date(inq.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-[var(--color-foreground)]">{inq.name}</p>
                  <p className="text-xs text-[var(--color-muted)]">{inq.email}</p>
                  <p className="text-xs text-[var(--color-muted)]">{inq.phone}</p>
                </td>
                <td className="px-4 py-3">{templeName(inq.temple)}</td>
                <td className="px-4 py-3">{tierName(inq.tier)}</td>
                <td className="px-4 py-3">{inq.preferred_dates || "—"}</td>
                <td className="px-4 py-3">{inq.group_size}</td>
                <td className="max-w-[220px] px-4 py-3 text-xs text-[var(--color-muted)]">
                  {inq.notes || "—"}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={inq.status}
                    disabled={updating === inq.id}
                    onChange={(e) => updateStatus(inq.id, e.target.value)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[inq.status]}`}
                  >
                    {INQUIRY_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopBar({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xl font-bold text-[var(--color-primary-dark)]">Inquiries</p>
        <p className="text-sm text-[var(--color-muted)]">
          Manage incoming booking-assistance requests.
        </p>
      </div>
      <button
        onClick={onLogout}
        className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary-dark)]"
      >
        Log out
      </button>
    </div>
  );
}
