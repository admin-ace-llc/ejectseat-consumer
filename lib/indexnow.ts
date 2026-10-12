// IndexNow: tells Bing (and so ChatGPT search, Copilot, DuckDuckGo, Yandex) about new/changed URLs immediately.
const KEY = '6f91df7729477c3e445758f5914a5bb0';

export async function pingIndexNow(urls: string[]): Promise<boolean> {
  const list = Array.from(new Set(urls)).slice(0, 100);
  if (!list.length) return false;
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: 'ejectseat.io', key: KEY, keyLocation: `https://ejectseat.io/${KEY}.txt`, urlList: list }),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
