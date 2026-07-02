import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { listInquiries } from "@/lib/db";
import InquiriesTable from "@/components/InquiriesTable";

export default async function AdminDashboardPage() {
  if (!(await isAuthenticated())) {
    redirect("/admin");
  }

  const inquiries = listInquiries();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <InquiriesTable initial={inquiries} />
    </div>
  );
}
