import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { SessionProvider } from "./components/session";
import { SiteHeader } from "./components/site-header";

export const metadata: Metadata = {
  title: "Blindroll — claim-based payroll on NEAR",
  description: "Payroll data is processed privately; only a Merkle root and a report hash go on-chain. Each contributor sees only their own row.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full font-mono selection:bg-[#0667DC] selection:text-white">
        <SessionProvider>
          {/* The header reads the current path, which is only known at request time on dynamic routes. */}
          <Suspense fallback={<div className="h-[57px] border-b border-[#322E25]/15 bg-[#E1D7C0]" />}>
            <SiteHeader />
          </Suspense>
          <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-8">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
