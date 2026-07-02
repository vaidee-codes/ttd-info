import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "yatra_admin_session";

function secret(): string {
  return process.env.AUTH_SECRET || "dev-only-insecure-secret-change-me";
}

function adminPassword(): string {
  return process.env.ADMIN_PASSWORD || "changeme";
}

function expectedToken(): string {
  return createHmac("sha256", secret()).update(adminPassword()).digest("hex");
}

export function checkPassword(password: string): boolean {
  const expected = Buffer.from(adminPassword());
  const provided = Buffer.from(password);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function createSession() {
  const store = await cookies();
  store.set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return false;
  const expected = expectedToken();
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
