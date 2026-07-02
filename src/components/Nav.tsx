import Link from "next/link";

const LINKS = [
  { href: "/services", label: "Temples We Support" },
  { href: "/how-it-works", label: "How It Works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/trust", label: "Trust & Legal" },
];

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-primary-light)] to-[var(--color-primary-dark)] text-lg text-white">
            🛕
          </span>
          <span className="text-lg font-bold tracking-tight text-[var(--color-primary-dark)]">
            Yatra Assist
          </span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-primary-dark)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <Link
          href="/contact"
          className="rounded-full bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-[var(--color-primary-dark)]"
        >
          Get Started
        </Link>
      </div>
    </header>
  );
}
