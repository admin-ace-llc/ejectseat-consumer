// File-based articles: content/articles/<slug>.md with a small frontmatter block.
// Loader is deliberately forgiving: a malformed file is skipped, never fatal to the build.
import fs from 'fs';
import path from 'path';

export interface Article {
  slug: string;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  updated: string;
  tags: string[];
  body: string;
}

const DIR = path.join(process.cwd(), 'content', 'articles');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(slug: string, raw: string): Article | null {
  const m = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  const { title, description, date } = meta;
  if (!title || !description || !date || !DATE.test(date)) return null;
  const updated = meta.updated && DATE.test(meta.updated) ? meta.updated : date;
  const tags = (meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const body = m[2].trim();
  if (body.length < 200) return null;
  return { slug, title, description, date, updated, tags, body };
}

export function listArticles(): Article[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const today = new Date().toISOString().slice(0, 10);
  const out: Article[] = [];
  for (const f of files) {
    const slug = f.slice(0, -3);
    if (!SLUG.test(slug)) continue;
    try {
      const a = parse(slug, fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (a && a.date <= today) out.push(a); // future-dated = scheduled
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getArticle(slug: string): Article | null {
  return listArticles().find((a) => a.slug === slug) ?? null;
}
