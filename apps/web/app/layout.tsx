import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { SessionProvider } from "./components/session";
import { SiteHeader } from "./components/site-header";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Blindroll — claim-based payroll on NEAR",
  description: "Payroll data is processed privately; only a Merkle root and a report hash go on-chain. Each contributor sees only their own row.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <SessionProvider>
          {/* The header reads the current path, which is only known at request time on dynamic routes. */}
          <Suspense fallback={<div className="h-[57px] border-b border-line bg-card" />}>
            <SiteHeader />
          </Suspense>
          <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-8">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
