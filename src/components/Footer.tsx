import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-[var(--color-border)] bg-[var(--color-tint)]">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-8 md:grid-cols-3">
          <div>
            <p className="text-lg font-bold text-[var(--color-primary-dark)]">
              🛕 Yatra Assist
            </p>
            <p className="mt-2 max-w-xs text-sm text-[var(--color-muted)]">
              A pilgrimage booking concierge. We coach you through official
              temple portals and handle your travel logistics — official
              ticket prices only, always your own login.
            </p>
          </div>

          <div>
            <p className="text-sm font-semibold text-[var(--color-foreground)]">
              Explore
            </p>
            <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
              <li>
                <Link href="/services" className="hover:text-[var(--color-primary-dark)]">
                  Temples we support
                </Link>
              </li>
              <li>
                <Link href="/how-it-works" className="hover:text-[var(--color-primary-dark)]">
                  How it works
                </Link>
              </li>
              <li>
                <Link href="/pricing" className="hover:text-[var(--color-primary-dark)]">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/trust" className="hover:text-[var(--color-primary-dark)]">
                  Trust &amp; legal
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-sm font-semibold text-[var(--color-foreground)]">
              Get in touch
            </p>
            <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
              <li>
                <Link href="/contact" className="hover:text-[var(--color-primary-dark)]">
                  Submit an inquiry
                </Link>
              </li>
              <li>
                <a href="mailto:hello@yatraassist.example" className="hover:text-[var(--color-primary-dark)]">
                  hello@yatraassist.example
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-[var(--color-border)] pt-6 text-xs text-[var(--color-muted)]">
          <p>
            Yatra Assist is an independent booking-coaching and travel
            logistics service. We are not affiliated with, endorsed by, or
            connected to TTD, the Travancore Devaswom Board, the Shri Mata
            Vaishno Devi Shrine Board, Shirdi Sai Baba Sansthan Trust, or any
            other temple authority. All darshan/seva tickets are booked by
            you, on the official portal, at the official price.
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} Yatra Assist. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
