import { createHash } from 'node:crypto';

export function computeGuid(item: {
  guid?: string | null;
  link?: string | null;
  title?: string | null;
  pubDate?: string | null;
  isoDate?: string | null;
}): string {
  if (item.guid && item.guid.trim()) return item.guid.trim();
  if (item.link && item.link.trim()) return item.link.trim();
  const dateStr = item.isoDate ?? item.pubDate ?? '';
  const titleStr = item.title ?? '';
  return createHash('sha256').update(`${titleStr}|${dateStr}`).digest('hex');
}
