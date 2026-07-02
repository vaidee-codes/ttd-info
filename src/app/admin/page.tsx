import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import AdminLoginForm from "@/components/AdminLoginForm";

export default async function AdminLoginPage() {
  if (await isAuthenticated()) {
    redirect("/admin/dashboard");
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-6 py-16">
      <div className="w-full rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm">
        <p className="text-xl font-bold text-[var(--color-primary-dark)]">
          Admin sign in
        </p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Yatra Assist team access only.
        </p>
        <div className="mt-6">
          <AdminLoginForm />
        </div>
      </div>
    </div>
  );
}
