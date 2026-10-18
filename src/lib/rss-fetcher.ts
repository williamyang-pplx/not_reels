import Parser from 'rss-parser';
import { computeGuid } from './guid';

export type RawRssItem = {
  guid?: string;
  link?: string;
  title?: string;
  pubDate?: string;
  isoDate?: string;
  contentSnippet?: string;
  content?: string;
  /** rss-parser's text-only copy of <content:encoded>, the full body some feeds send beside a short <description>. */
  'content:encodedSnippet'?: string;
  /** Atom <summary> (HTML). */
  summary?: string;
  /** YouTube puts the video description only in <media:group><media:description>. */
  mediaGroup?: { 'media:description'?: string[] };
  creator?: string;
  author?: string;
};

export type ParsedFeed = {
  title?: string;
  items: RawRssItem[];
};

export interface NormalizedItem {
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  author: string | null;
  publishedAt: Date;
  sourceRank: number | null;
}

export const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:group', 'mediaGroup'],
    ],
  },
}) as Parser<unknown, RawRssItem>;

const FETCH_HEADERS = {
  'User-Agent': 'not-brainrot/1.0 (RSS reader; +https://github.com/williamyang-pplx/not_reels)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
};
const FETCH_TIMEOUT_MS = 10_000;

export type FeedFetcher = (url: string) => Promise<ParsedFeed>;

export const defaultFetcher: FeedFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: string;
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const result = await parser.parseString(body);
  return { title: result.title, items: result.items as RawRssItem[] };
};

export function normalizeItem(
  item: RawRssItem,
  now: Date = new Date(),
  sourceRank: number | null = null,
): NormalizedItem {
  const guid = computeGuid(item);
  const title = (item.title ?? '').trim() || '(untitled)';
  const link = (item.link ?? '').trim();
  const summary = longestText([
    item['content:encodedSnippet'],
    item.contentSnippet ?? item.content,
    item.summary && htmlToText(item.summary),
    item.mediaGroup?.['media:description']?.[0] && cleanVideoDescription(item.mediaGroup['media:description'][0]),
  ]);
  const author = (item.creator ?? item.author ?? '').trim() || null;
  const dateStr = item.isoDate ?? item.pubDate;
  const parsed = dateStr ? new Date(dateStr) : null;
  const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return {
    guid,
    title,
    link,
    summary,
    author,
    publishedAt,
    sourceRank,
  };
}

/** The longest candidate wins: a feed's full body is not always the field one would guess (smol.ai's is shorter). */
function longestText(candidates: (string | null | undefined | false)[]): string | null {
  let best = '';
  for (const c of candidates) {
    const t = c ? c.trim() : '';
    if (t.length > best.length) best = t;
  }
  return best || null;
}

/** Tags out, block ends turned into line breaks. Entities are left for the display layer to decode. */
function htmlToText(html: string): string {
  return html.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
}

/** YouTube descriptions are mostly links, timestamps, hashtags and credits; keep the prose. */
function cleanVideoDescription(text: string): string {
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

export function normalizeAll(items: RawRssItem[], now: Date = new Date()): NormalizedItem[] {
  return items.map((it, index) => normalizeItem(it, now, index));
}
