import { z } from 'zod';
import type { NormalizedItem } from '../rss-fetcher';

const LocalFeedItemSchema = z.object({
  guid: z.string().trim().min(1),
  title: z.string().trim().min(1),
  link: z.string().trim().url(),
  summary: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  publishedAt: z.union([z.date(), z.string().trim().min(1)]).nullable().optional(),
  sourceRank: z.number().int().min(0).nullable().optional(),
});

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed || null;
}

function normalizePublishedAt(value: Date | string | null | undefined, now: Date): Date {
  if (value === null || value === undefined) return now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Local feed item has invalid publishedAt');
  }
  return date;
}

export function normalizeLocalFeedItems(
  items: unknown,
  now: Date = new Date(),
): NormalizedItem[] {
  return z.array(LocalFeedItemSchema).parse(items).map((item, index) => ({
    guid: item.guid,
    title: item.title,
    link: item.link,
    summary: normalizeOptionalText(item.summary),
    author: normalizeOptionalText(item.author),
    publishedAt: normalizePublishedAt(item.publishedAt, now),
    sourceRank: item.sourceRank === undefined ? index : item.sourceRank,
  }));
}
