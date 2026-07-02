export type Inquiry = {
  id: number;
  created_at: string;
  name: string;
  email: string;
  phone: string;
  temple: string;
  tier: string;
  preferred_dates: string | null;
  group_size: number;
  notes: string | null;
  status: string;
};

export type NewInquiry = Omit<Inquiry, "id" | "created_at" | "status">;

export const INQUIRY_STATUSES = [
  "new",
  "contacted",
  "in_progress",
  "completed",
] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
