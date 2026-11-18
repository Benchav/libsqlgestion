import type { Metadata } from 'next';
import { Manrope, Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { QueryProvider } from '../lib/query-provider';
import { ErrorBoundary } from '../components/ErrorBoundary';
import './globals.css';

const manrope = Manrope({ subsets: ['latin'], variable: '--font-sans' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });
const ibmPlexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'libsqlite',
  description: 'Self-hosted SQLite and libsql control plane',
  // Browser translation mutates the DOM and can break React's removeChild()
  // during conditional renders. Keep the control plane untranslated; a real
  // i18n layer should be used if localized UI is required.
  other: {
    google: 'notranslate',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      translate="no"
      className={`notranslate ${manrope.variable} ${spaceGrotesk.variable} ${ibmPlexMono.variable}`}
    >
      <body className="notranslate">
        <QueryProvider>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </QueryProvider>
      </body>
    </html>
  );
}
