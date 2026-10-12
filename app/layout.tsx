import type { Metadata } from 'next';
import './globals.css';
import Script from 'next/script';

export const metadata: Metadata = {
  metadataBase: new URL('https://ejectseat.io'),
  title: {
    default: 'EjectSeat — Layoffs as they are filed with the SEC',
    template: '%s | EjectSeat',
  },
  description:
    'A live feed of US public-company layoffs and restructurings, read from SEC filings within hours, plus forward-looking layoff risk scores.',
  openGraph: { siteName: 'EjectSeat', type: 'website', images: [{ url: 'https://ejectseat.io/api/og', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', site: '@ejectseat', images: ['https://ejectseat.io/api/og'] },
  alternates: { types: { 'application/rss+xml': 'https://ejectseat.io/layoffs/feed.xml' } },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,600..900&family=Public+Sans:wght@400;600;700&display=swap"
        />
      </head>
      <body>
        {children}
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-08WLHSJJ79" strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-08WLHSJJ79');`}
        </Script>
        <Script src="/_vercel/insights/script.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
