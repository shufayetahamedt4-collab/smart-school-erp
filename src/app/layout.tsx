import type { Metadata, Viewport } from "next";
import { InstallBanner } from "@/components/InstallApp";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Amar E School", template: "%s · Amar E School" },
  description:
    "Amar E School — a multi-tenant SaaS platform for kindergartens, schools and coaching institutes.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Amar E School",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <InstallBanner />
      </body>
    </html>
  );
}
