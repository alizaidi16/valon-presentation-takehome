import type { Metadata } from "next";
import { Albert_Sans, Cormorant, Geist_Mono } from "next/font/google";
import "./globals.css";

/**
 * valon.ai uses Adobe Season + Melange. We approximate with google fonts —
 * pairing should feel editorial serif + restrained geometric sans like the marketing site.
 */
const fontSeason = Cormorant({
  subsets: ["latin"],
  variable: "--font-season",
  display: "swap",
  weight: ["400", "500", "600", "700"]
});

const fontMelange = Albert_Sans({
  subsets: ["latin"],
  variable: "--font-melange",
  display: "swap",
  weight: ["400", "500", "600", "700"]
});

const fontGeistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Deck Studio — Valon",
  description:
    "AI-routed slide generation. Format-aware deck builder with image and structured layouts."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fontSeason.variable} ${fontMelange.variable} ${fontGeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
