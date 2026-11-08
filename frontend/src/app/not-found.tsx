import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="glass w-full max-w-[420px] px-7 py-8 text-center">
        <svg width="44" height="44" viewBox="0 0 16 16" className="mx-auto text-text" aria-hidden>
          <rect x="2" y="1.5" width="12" height="13" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <path d="M3 9h10v2.5A2 2 0 0 1 11 13.5H5A2 2 0 0 1 3 11.5z" fill="var(--water)" />
          <path d="M2.6 5h10.8" stroke="var(--crit)" strokeWidth="0.9" strokeDasharray="1.4 1" />
        </svg>
        <h1 className="tracking-display mt-5 font-display text-[26px] leading-tight font-bold text-text">Page not found</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">That page doesn&apos;t exist. The console is one click away.</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-[10px] bg-water px-5 py-[9px] text-[14px] font-semibold text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(10,132,255,0.35)] transition-colors hover:bg-water-deep"
        >
          Back to console
        </Link>
      </div>
    </main>
  );
}
