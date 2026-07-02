import { NextRequest, NextResponse } from "next/server";
import { createInquiry, listInquiries, type NewInquiry } from "@/lib/db";
import { isAuthenticated } from "@/lib/auth";
import { TEMPLES, SERVICE_TIERS } from "@/lib/content";

const TEMPLE_SLUGS = new Set(TEMPLES.map((t) => t.slug));
const TIER_IDS = new Set(SERVICE_TIERS.map((t) => t.id));

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { name, email, phone, temple, tier, preferred_dates, group_size, notes } = body;

  if (!isNonEmptyString(name) || name.length > 200) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!isNonEmptyString(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (!isNonEmptyString(phone) || phone.length > 30) {
    return NextResponse.json({ error: "Phone is required" }, { status: 400 });
  }
  if (!isNonEmptyString(temple) || !TEMPLE_SLUGS.has(temple)) {
    return NextResponse.json({ error: "Please select a valid temple" }, { status: 400 });
  }
  if (!isNonEmptyString(tier) || !TIER_IDS.has(tier)) {
    return NextResponse.json({ error: "Please select a valid service tier" }, { status: 400 });
  }
  const groupSizeNum = Number(group_size);
  if (!Number.isInteger(groupSizeNum) || groupSizeNum < 1 || groupSizeNum > 50) {
    return NextResponse.json({ error: "Group size must be between 1 and 50" }, { status: 400 });
  }

  const input: NewInquiry = {
    name: name.trim(),
    email: email.trim(),
    phone: phone.trim(),
    temple,
    tier,
    preferred_dates: isNonEmptyString(preferred_dates) ? preferred_dates.trim().slice(0, 200) : null,
    group_size: groupSizeNum,
    notes: isNonEmptyString(notes) ? notes.trim().slice(0, 2000) : null,
  };

  const inquiry = createInquiry(input);
  return NextResponse.json({ inquiry }, { status: 201 });
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ inquiries: listInquiries() });
}
