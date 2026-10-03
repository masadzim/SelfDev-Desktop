/**
 * Small, dependency-free Markdown renderer.
 *
 * Block parsing happens on raw text; inline formatting is applied only after
 * HTML-escaping, so model output can never inject markup.
 */

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderInline(input: string): string {
  const codes: string[] = [];
  let out = escapeHtml(input);

  // inline code first so its contents are never re-formatted
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0001C${codes.length - 1}\u0001`;
  });

  out = out
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // [label](https://…)
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // bare URLs, but never the ones we just put inside href="…"
  out = out.replace(/(?<![">=\w])((?:https?:\/\/)[^\s<>()]*[^\s<>().,;:!?])/g, (m: string) => {
    const trailing = /[.,;:!?]$/.exec(m)?.[0] ?? '';
    const url = trailing ? m.slice(0, -trailing.length) : m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });

  out = out.replace(/\u0001C(\d+)\u0001/g, (_m, i: string) => codes[Number(i)] ?? '');
  return out;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d{1,9})[.)]\s+(.*)$/;

export function renderMarkdown(source: unknown): string {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const closing = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${len},}\\s*$`);
        if (closing.test(lines[i])) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const code = body.join('\n');
      const label = lang ? `<span class="sd-code-lang">${escapeHtml(lang)}</span>` : '';
      out.push(`<pre class="sd-code">${label}<code>${escapeHtml(code)}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(QUOTE_RE.exec(lines[i])?.[1] ?? '');
        i++;
      }
      out.push(`<blockquote>${renderInline(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = !UL_RE.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? OL_RE.exec(cur) : UL_RE.exec(cur);
        if (!m) {
          // continuation line of the previous item
          if (items.length && /^\s{2,}\S/.test(cur)) {
            items[items.length - 1] += `\n${cur.trim()}`;
            i++;
            continue;
          }
          break;
        }
        items.push(renderInline(ordered ? (m[2] as string) : (m[1] as string)));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
      continue;
    }

    // paragraph: consume until a blank line or the start of another block
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (
        i > para.length &&
        (FENCE_RE.test(cur) || HEADING_RE.test(cur) || HR_RE.test(cur) || QUOTE_RE.test(cur) || UL_RE.test(cur) || OL_RE.test(cur))
      ) {
        break;
      }
      para.push(cur.trim());
      i++;
    }
    if (para.length) out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('');
}