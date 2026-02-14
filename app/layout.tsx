import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Just a List",
  description: "Collaborative checklist app for Telegram",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var lc = localStorage.getItem('app_locale');
            if (!lc || ['en','he','ru'].indexOf(lc) === -1) {
              var u = window.Telegram && Telegram.WebApp && Telegram.WebApp.initDataUnsafe;
              lc = u && u.user && u.user.language_code || null;
            }
            if (lc === 'he') { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'he'; }
            else if (lc === 'ru') { document.documentElement.lang = 'ru'; }
          } catch(e) {}
        `}} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        {children}
      </body>
    </html>
  );
}
