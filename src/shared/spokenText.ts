/**
 * Turning a markdown answer into something worth listening to.
 *
 * A synthesiser reads markdown out loud literally — "hash", "asterisk asterisk",
 * "backtick" — so the markup has to come off first. The rules are the Android
 * client's, because they are the ones already tuned against what actually sounds
 * bad.
 */

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]*)`/g;
const IMAGE = /!\[([^\]]*)]\([^)]*\)/g;
const LINK = /\[([^\]]*)]\([^)]*\)/g;
const BOLD = /\*\*([^*]+)\*\*/g;
// No lookbehind: the bundler's target does not support it, so the preceding
// character is captured and put back instead.
const ITALIC = /(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g;
const STRIKE = /~~([^~]+)~~/g;
const HIGHLIGHT = /==([^=]+)==/g;
const HEADING = /^#{1,6}\s*/gm;
const QUOTE_MARK = /^[ \t]*>[ \t]?/gm;
const BULLET = /^[ \t]*[-*+][ \t]+/gm;
const TASK_DONE = /^[ \t]*[-*+]?[ \t]*\[[xX✓]\][ \t]*/gm;
const TASK_OPEN = /^[ \t]*[-*+]?[ \t]*\[ \][ \t]*/gm;
const ORDERED = /^[ \t]*\d+[.)][ \t]*/gm;
const CALLOUT = /^[ \t]*>[ \t]*\[!\w+\][ \t]*/gm;
const RULE = /^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/gm;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm;
// JavaScript has no inline (?m) flag; the `m` flag above does the same job,
// which is why these rules are written as flags rather than as Kotlin's Regex().
const MULTISPACE = /[ \t]{2,}/g;
const BLANK_LINES = /\n{3,}/g;

/** The longest text a synthesiser should be handed in one go. */
export const CHUNK_LIMIT = 220;

/**
 * @param includeCode read a fenced block out loud as prose. A wall of code is
 *   noise to listen to, so it is skipped unless the user asked for it.
 */
export function fromMarkdown(source: string, includeCode = false): string {
  let text = source.replace(FENCE, (block) =>
    includeCode
      ? block
          .replace(/^```/, '')
          .replace(/```$/, '')
          .split('\n')
          .slice(1)
          .join('\n')
          .replace(/^\s*[-=*#]{3,}\s*$/gm, ' ')
      : ' '
  );
  text = text.replace(IMAGE, '$1');
  text = text.replace(LINK, '$1');
  text = text.replace(BOLD, '$1');
  text = text.replace(HIGHLIGHT, '$1');
  text = text.replace(STRIKE, '$1');
  text = text.replace(ITALIC, '$1$2');
  text = text.replace(INLINE_CODE, '$1');
  text = text.replace(CALLOUT, '');
  // Kept as a newline rather than nothing: dropping it would weld the two rows
  // either side of the divider together into one unreadable line.
  text = text.replace(TABLE_DIVIDER, '\n');
  // A table read column by column is meaningless, so the row becomes a phrase.
  text = text.replace(TABLE_ROW, (row) => {
    const cells = row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(', ');
    return cells || ' ';
  });
  text = text.replace(RULE, '\n');
  text = text.replace(HEADING, '');
  text = text.replace(TASK_DONE, 'Selesai. ');
  text = text.replace(TASK_OPEN, 'Belum. ');
  text = text.replace(ORDERED, '');
  text = text.replace(BULLET, '');
  text = text.replace(QUOTE_MARK, '');
  text = text.replace(/&amp;/g, 'dan').replace(/&lt;/g, 'kurang dari').replace(/&gt;/g, 'lebih dari');
  text = text.replace(MULTISPACE, ' ');
  // A line the markup left with nothing but spaces should not be read as a pause.
  text = text.replace(/^[ \t]+$/gm, '');
  text = text.replace(BLANK_LINES, '\n\n');
  return text.trim();
}

/**
 * Breaks after a stop that is followed by a space, the one signal that survives
 * both cases we care about: a full stop mid-list ("Nomor 1. Kalimat berikutnya")
 * ends a thought, while a decimal ("1.250") or an abbreviation ("unit.apore")
 * does not.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;
    if (!'.!?\n'.includes(char)) continue;
    const next = text[i + 1];
    const endsHere = char === '.' ? next === undefined || /\s/.test(next) : true;
    if (endsHere) {
      out.push(current);
      current = '';
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Splits at sentence ends so a long answer is spoken in order with a natural
 * pause, instead of one queued blob that starts minutes late.
 */
export function chunks(text: string, limit = CHUNK_LIMIT): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  let current = '';
  for (const sentence of splitSentences(text)) {
    if (current && current.length + sentence.length + 1 > limit) {
      out.push(current.trim());
      current = '';
    }
    if (sentence.length > limit) {
      // A single run-on sentence still has to be broken somewhere.
      for (let i = 0; i < sentence.length; i += limit) {
        if (current) {
          out.push(current.trim());
          current = '';
        }
        out.push(sentence.slice(i, i + limit));
      }
    } else {
      if (current) current += ' ';
      current += sentence;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter((c) => c.trim().length > 0);
}