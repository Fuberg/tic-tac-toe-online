import type { Metadata } from "next";
import { Comfortaa, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Rounded, friendly display face for headings only — body copy and controls stay on Geist
// so the playful touch doesn't compromise legibility. Needs Cyrillic coverage since most
// headings ("Лобби", "Матч против: …") are Russian, unlike Geist above (latin only).
const comfortaa = Comfortaa({
  variable: "--font-display",
  weight: ["600", "700"],
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Tic-Tac-Toe Online",
  description: "Крестики-нолики онлайн с исчезающими фишками",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${geistSans.variable} ${geistMono.variable} ${comfortaa.variable}`}>
      <body>{children}</body>
    </html>
  );
}
