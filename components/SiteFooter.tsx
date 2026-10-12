import Link from 'next/link';

export default function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="wrap">
        <p>
          Layoff events are read from public SEC EDGAR filings (Form 8-K, Item 2.05). Risk scores are
          forward-looking estimates, not statements of fact or investment advice.
        </p>
        <nav aria-label="Footer">
          <Link href="/layoffs">Latest layoffs</Link>
          <Link href="/companies">Risk scores</Link>
          <a href="/how.html">How it works</a>
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Terms</a>
        </nav>
      </div>
    </footer>
  );
}
