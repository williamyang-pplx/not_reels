import { REDDIT_HOSTS, extractRedditPost } from './embed';
import type { RawRssItem } from './rss-fetcher';

/**
 * Reddit allows few unauthenticated RSS requests per IP (one per clock minute when measured in 2026-11)
 * and answers 429 to the rest. A full refresh therefore reads subreddit feeds through multireddit URLs
 * (`/r/a+b+c/hot.rss`), a few subreddits per request so that each one gets a share of the 100 entries,
 * with the requests spaced REDDIT_REQUEST_INTERVAL_MS apart. The entries are split back by the subreddit
 * in each post link.
 */

export const MULTIREDDIT_ITEM_LIMIT = 100;
export const SUBREDDITS_PER_REQUEST = 8;
export const REDDIT_REQUEST_INTERVAL_MS = 61_000;

let lastRedditRequestAt = Number.NEGATIVE_INFINITY;

/** Record a request to any Reddit URL, so that queued multireddit requests keep their distance from it. */
export function noteRedditRequest(): void {
  lastRedditRequestAt = Date.now();
}

export function msUntilNextRedditRequest(intervalMs: number): number {
  return Math.max(0, lastRedditRequestAt + intervalMs - Date.now());
}

/** Unique subreddits in first-seen order, split into groups of at most `size`. */
export function chunkSubreddits(subreddits: string[], size: number = SUBREDDITS_PER_REQUEST): string[][] {
  const unique = Array.from(new Set(subreddits));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

export interface SubredditFeed {
  subreddit: string;
  sort: string;
}

// /r/<sub>.rss, /r/<sub>/.rss, /r/<sub>/<sort>.rss, /r/<sub>/<sort>/.rss
const SUBREDDIT_FEED_PATH = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/(hot|new|rising|top|controversial))?\/?\.rss$/i;

/** A plain subreddit listing feed with no query string, or null if the URL is anything else. */
export function parseSubredditFeedUrl(feedUrl: string): SubredditFeed | null {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }
  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase()) || url.search) return null;
  const match = SUBREDDIT_FEED_PATH.exec(url.pathname);
  if (!match) return null;
  return { subreddit: match[1].toLowerCase(), sort: (match[2] ?? 'hot').toLowerCase() };
}

export function multiredditFeedUrl(subreddits: string[], sort: string): string {
  const subs = Array.from(new Set(subreddits)).join('+');
  return `https://www.reddit.com/r/${subs}/${sort}.rss?limit=${MULTIREDDIT_ITEM_LIMIT}`;
}

/** Entries keyed by lowercase subreddit, in feed order. Entries without a post link are dropped. */
export function groupItemsBySubreddit(items: RawRssItem[]): Map<string, RawRssItem[]> {
  const groups = new Map<string, RawRssItem[]>();
  for (const item of items) {
    const subreddit = extractRedditPost(item.link ?? '')?.subreddit.toLowerCase();
    if (!subreddit) continue;
    const group = groups.get(subreddit);
    if (group) group.push(item);
    else groups.set(subreddit, [item]);
  }
  return groups;
}
