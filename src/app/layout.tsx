import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/legal/ThemeProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Հայկական իրավական որոնում — ARLIS",
    template: "%s — Հայկական իրավական որոնում",
  },
  description:
    "Արագ որոնում Հայաստանի օրենսդրությունում ARLIS աղբյուրով։ Ստացեք ամենատեղին ունեցող իրավական ակտերը և AI վերլուծությունը՝ հղումով դեպի սկզբնաղբյուր։",
  keywords: [
    "ARLIS",
    "Հայաստանի օրենսդրություն",
    "իրավական որոնում",
    "քրեական օրենսգիրք",
    "քաղաքացիական օրենսգիրք",
    "Հայաստանի Հանրապետություն",
    "իրավունք",
  ],
  authors: [{ name: "Armenian Legal Search" }],
  applicationName: "Armenian Legal Search",
  robots: { index: true, follow: true },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Հայկական իրավական որոնում — ARLIS",
    description:
      "Արագ որոնում Հայաստանի օրենսդրությունում ARLIS աղբյուրով՝ AI վերլուծությամբ։",
    siteName: "Armenian Legal Search",
    locale: "hy_AM",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Հայկական իրավական որոնում — ARLIS",
    description:
      "Արագ որոնում Հայաստանի օրենսդրությունում ARLIS աղբյուրով։",
  },
  category: "legal",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

// Dark mode only — no theme toggle, no light mode
const themeInitScript = `
(function() {
  document.documentElement.classList.add('dark');
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="hy" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
        style={{
          fontFamily:
            "'Noto Sans Armenian','Noto Serif Armenian','DejaVu Sans',var(--font-geist-sans),system-ui,-apple-system,sans-serif",
        }}
      >
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
