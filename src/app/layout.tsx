import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { TelegramWebAppInit } from "@/components/telegram-web-app-init";

export const metadata: Metadata = {
  title: "TON AI Agent",
  description: "TON hackathon mini app with TON Connect, AI intent parsing, and MCP-ready flows"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f7fb"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        <TelegramWebAppInit />
        <div id="tc-widget-root" />
        {children}
      </body>
    </html>
  );
}
