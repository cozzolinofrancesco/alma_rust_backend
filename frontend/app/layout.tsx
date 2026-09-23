import type { Metadata } from "next";
import AuthGuard from "./components/AuthGuard";
import ConditionalNavbar from "./components/ConditionalNavbar";
import DevBanner from "./components/DevBanner";
import SessionExpiredBanner from "./components/SessionExpiredBanner";
import { GlobalTutorialSystem } from "./components/GlobalTutorialSystem";
import DailyHelpPromptController from "./components/DailyHelpPromptController";

import { Providers } from "./components/providers";
import ClientWrapper from "./components/SplashScreenWrapper";
import "./components/tutorial/tutorial.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alma",
  description: "PRED Tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before paint to avoid a flash (mirrors ThemeContext init). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme-dark-mode');var d=s===null?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches):s==='true';document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`,
          }}
        />
        {}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

        {}
        <link
          rel="preload"
          href="https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />

        {}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

        {}
        <style dangerouslySetInnerHTML={{
          __html: `
            body {
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            }
            
            /* Ensure text is visible during font load */
            @font-face {
              font-family: 'Inter';
              font-style: normal;
              font-weight: 100 900;
              font-display: swap;
              src: url(https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2) format('woff2');
              unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
            }
          `
        }} />
      </head>
      <body
        className="antialiased"
        suppressHydrationWarning={true}
      >
        <ClientWrapper>
          <Providers>
            <div className="app-shell">
              <SessionExpiredBanner />
              <ConditionalNavbar />
              <main className="app-main">
                <AuthGuard>
                  {children}
                </AuthGuard>
              </main>
              <GlobalTutorialSystem />
              <DailyHelpPromptController />
              <DevBanner />
            </div>
          </Providers>
        </ClientWrapper>
      </body>
    </html>
  );
}
