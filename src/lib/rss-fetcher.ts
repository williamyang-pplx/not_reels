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
  contentEncoded?: string;
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
      ['content:encoded', 'contentEncoded'],
    ],
  },
}) as Parser<unknown, RawRssItem>;

const FETCH_HEADERS = {
  'User-Agent': 'not-reels/1.0 (RSS reader; +https://github.com/williamyang-pplx/not_reels)',
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
  const summary =
    (item.contentSnippet ?? item.content ?? item.contentEncoded ?? '').trim() ||
    null;
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

export function normalizeAll(items: RawRssItem[], now: Date = new Date()): NormalizedItem[] {
  return items.map((it, index) => normalizeItem(it, now, index));
}
