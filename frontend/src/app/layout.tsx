import type { Metadata } from "next";
import "./globals.css";
import { themeScript } from "@/components/console/theme-toggle";

export const metadata: Metadata = {
  title: { default: "Beat the Shutdown", template: "%s | Beat the Shutdown" },
  description:
    "Console for a produced-water network: what is failing, how long until it shuts in, and the cheapest way to keep it running.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets class="dark" before paint, so React must not complain about the mismatch.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full text-text">{children}</body>
    </html>
  );
}
