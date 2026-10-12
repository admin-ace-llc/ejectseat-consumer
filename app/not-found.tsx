import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="wrap">
        <section className="hero">
          <h1>That page does not exist</h1>
          <p className="lede">Check the address, or go to the latest layoffs.</p>
          <Link className="btn" href="/layoffs">See latest layoffs</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
