import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Beat the Shutdown", template: "%s | Beat the Shutdown" },
  description:
    "Console for a produced-water network: what is failing, how long until it shuts in, and the cheapest way to keep it running.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full text-text">{children}</body>
    </html>
  );
}
