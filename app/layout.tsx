import type { Metadata } from "next";
import Script from "next/script";

import "./globals.css";

export const metadata: Metadata = {
  title: "Money Pro X"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body className="h-screen flex flex-col antialiased">
        {children}

        {/* Legacy vendor deps (kept for parity with index.html) */}
        <Script
          src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
          strategy="beforeInteractive"
        />
        <Script src="https://unpkg.com/lucide@latest" strategy="beforeInteractive" />
        <Script
          src="https://unpkg.com/@supabase/supabase-js@2"
          strategy="beforeInteractive"
        />

        {/* Legacy app script (extracted from index.html) */}
        <Script src="/legacy/app.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}

