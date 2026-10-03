import { ToolResult } from '../../shared/types';
import { trunc } from './fsTools';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 SelfDev/1.0';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML = 4 * 1024 * 1024;

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: '*/*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    return text.length > MAX_HTML ? text.slice(0, MAX_HTML) : text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  return JSON.parse(await fetchText(url, timeoutMs)) as unknown;
}

export async function webSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return { content: 'query kosong', isError: true };

  const sources: string[] = [];

  // 1) DuckDuckGo Instant Answer
  try {
    const j = (await fetchJson(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    )) as { AbstractText?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>; Results?: Array<{ Text?: string }> };
    const lines: string[] = [];
    if (j.AbstractText) lines.push(j.AbstractText);
    (j.RelatedTopics ?? []).forEach((t) => {
      if (t.Text) lines.push(`- ${t.Text}${t.FirstURL ? `  (${t.FirstURL})` : ''}`);
    });
    (j.Results ?? []).forEach((t) => {
      if (t.Text) lines.push(`- ${t.Text}`);
    });
    if (lines.length) sources.push(`— DuckDuckGo —\n${trunc(lines.join('\n'), 8000)}`);
  } catch {
    /* ignore */
  }

  // 2) Wikipedia
  for (const lang of ['id', 'en']) {
    try {
      const j = (await fetchJson(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
          query
        )}&srlimit=5&format=json&origin=*`
      )) as { query?: { search?: Array<{ title: string; snippet: string }> } };
      const hits = (j.query?.search ?? [])
        .map((h) => `- ${h.title}: ${h.snippet.replace(/<[^>]+>/g, '')}`)
        .join('\n');
      if (hits) {
        sources.push(`— Wikipedia (${lang}) —\n${trunc(hits, 6000)}`);
        break;
      }
    } catch {
      /* ignore */
    }
  }

  // 3) Wikipedia summary (useful for "apa itu X" style queries)
  try {
    const slug = query.trim().replace(/\s+/g, '_');
    const j = (await fetchJson(
      `https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`
    )) as { extract?: string; title?: string };
    if (j.extract) sources.push(`— Wikipedia ringkasan —\n${trunc(j.extract, 4000)}`);
  } catch {
    /* ignore */
  }

  if (!sources.length) {
    return { content: 'Tidak ada hasil dari sumber web (duckduckgo/wikipedia). Periksa koneksi internet.', isError: true };
  }
  return { content: sources.join('\n\n') };
}

export async function webFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return { content: 'URL harus diawali http:// atau https://', isError: true };
  try {
    const raw = await fetchText(url);
    const isHtml = /<\s*(html|body|div|p|span)\b/i.test(raw);
    if (!isHtml) return { content: `[${url}]\n\n${trunc(raw, 12000)}` };

    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const clean = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      content: `[${url}]${title ? `\nTitle: ${title}` : ''}\n\n${trunc(clean || raw, 12000)}`
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { content: `Gagal fetch "${url}": ${m}`, isError: true };
  }
}