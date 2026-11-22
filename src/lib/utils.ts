export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function formatRelativeTime(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4 Mar 2014": a video's upload day (UTC). A fixed month list, since en-GB gives "Sept" in Node's ICU. */
export function formatUploadDate(date: Date | string): string {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Feed text keeps the source's hard line wraps, and a single newline is also how it marks paragraphs. Keep a
 * break only where the line ends a sentence (or the source left a blank line) and join the rest with a space.
 * Paragraphs come back separated by a blank line.
 */
export function reflowText(text: string): string {
  const paragraphs: string[] = [];
  let current = '';
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current) paragraphs.push(current);
      current = '';
    } else if (current && /[.!?:;…"”’)]$/.test(current)) {
      paragraphs.push(current);
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join('\n\n');
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + '…';
}


/** djb2-xor hash of a topic slug mapped to a hue (spec §7). */
export function topicColor(slug: string | undefined | null): string {
  if (!slug) return 'hsl(220, 10%, 40%)';
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h) ^ slug.charCodeAt(i);
  return `hsl(${Math.abs(h) % 360}, 70%, 60%)`;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Decode HTML entities that some feeds leave (or double-encode) in titles and summaries. Display only. */
export function decodeEntities(str: string): string {
  if (!str.includes('&')) return str;
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** A non-2xx response. Duck-typed by `status` so callers need not load the module that threw it. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Status code ${status}`);
  }
}

/** YouTube descriptions are mostly links, timestamps, hashtags and credits; keep the prose. */
export function cleanVideoDescription(text: string): string {
  const lines = text.split('\n');
  const credits = lines.findIndex((l) => /^\s*(special thanks|thanks to (all )?(my|our|these)|this video (was|is) (sponsored|made possible))/i.test(l));
  return (credits >= 0 ? lines.slice(0, credits) : lines)
    .filter((line) => {
      const l = line.trim();
      return !(
        /https?:\/\//i.test(l) || // sponsor, social and merch links
        /^\(?\d{1,2}:\d{2}(?::\d{2})?\)?(\s|$)/.test(l) || // chapter timestamps
        /^[-—–_=*•~\s]{3,}$/.test(l) || // dividers
        /^(#[\p{L}\p{N}_]+\s*)+$/u.test(l) || // hashtag lines
        /^[\p{L}\s&/]{1,30}:$/u.test(l) // a label like "Social media:" whose links were dropped
      );
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
