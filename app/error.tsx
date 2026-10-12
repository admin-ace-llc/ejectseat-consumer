'use client';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="wrap">
      <section className="hero">
        <h1>Something went wrong</h1>
        <p className="lede">The page could not load. This is usually temporary.</p>
        <button className="btn" onClick={() => reset()}>Try again</button>
      </section>
    </main>
  );
}
