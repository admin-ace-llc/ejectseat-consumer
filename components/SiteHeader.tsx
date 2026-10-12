import Link from 'next/link';

export default function SiteHeader({ current }: { current?: 'home' | 'layoffs' | 'companies' | 'check' | 'about' | 'warn' }) {
  const cur = (k: string) => (current === k ? ('page' as const) : undefined);
  return (
    <header className="site-head">
      <div className="wrap">
        <Link href="/" className="logo" aria-label="EjectSeat home">
          <i aria-hidden="true" /> EjectSeat
        </Link>
        <nav className="site-nav" aria-label="Main">
          <Link href="/layoffs" aria-current={cur('layoffs')}>Latest layoffs</Link>
          <a href="/check.html" aria-current={cur('check')}>Check a company</a>
          <Link href="/warn" aria-current={cur('warn')}>WARN notices</Link>
          <Link href="/about" aria-current={cur('about')}>How we source</Link>
          <a href="/layoffs/feed.xml">RSS</a>
        </nav>
      </div>
    </header>
  );
}
