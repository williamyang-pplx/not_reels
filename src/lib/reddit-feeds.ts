import { REDDIT_HOSTS, type RedditPost } from './embed';

/**
 * Subreddit feeds (sourceKind REDDIT) are never fetched: each one is shown as a window framing its page on a
 * self-hosted Redlib (src/redlib.ts). These helpers recognise subreddit URLs, build the Redlib paths, and place
 * the windows among a view's cards.
 */

export interface SubredditFeed {
  /** Lowercase. */
  subreddit: string;
  /** hot, new, rising, top or controversial. */
  sort: string;
}

// The page a user pastes (/r/<sub>, /r/<sub>/, /r/<sub>/<sort>) and the old RSS forms (/r/<sub>.rss,
// /r/<sub>/.rss, /r/<sub>/<sort>.rss, /r/<sub>/<sort>/.rss).
const SUBREDDIT_PATH = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/(hot|new|rising|top|controversial))?\/?(?:\.rss)?$/i;

/** A subreddit listing URL (page or RSS) on a Reddit host with no query string, or null if the URL is anything else. */
export function parseSubredditFeedUrl(feedUrl: string): SubredditFeed | null {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }
  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase()) || url.search) return null;
  const match = SUBREDDIT_PATH.exec(url.pathname);
  if (!match) return null;
  return { subreddit: match[1].toLowerCase(), sort: (match[2] ?? 'hot').toLowerCase() };
}

/** Same-origin path of the Redlib page for a subreddit feed, e.g. /r/listentothis/hot. */
export function redlibSubredditPath(feed: SubredditFeed): string {
  return `/r/${feed.subreddit}/${feed.sort}`;
}

/** Same-origin path of the Redlib page for one thread, e.g. /r/unixporn/comments/1xv94f8/hyprland_lucid_121. */
export function redlibThreadPath(post: RedditPost): string {
  const path = `/r/${post.subreddit}/comments/${post.postId}`;
  return post.slug ? `${path}/${post.slug}` : path;
}

/** The feed positions (0-based) windows take, in the order they fill. Windows past the fifth go right after position 4. */
const WINDOW_SLOTS = [0, 2, 4, 1, 3];

type FeedEntry<I, W> = { item: I } | { window: W };

/**
 * Put windows into the first page of the feed: window k (k < 5) takes position WINDOW_SLOTS[k]. The taken
 * positions are filled in ascending order, so windows keep their order. Windows past the fifth go right after
 * position 4. When items run out, the remaining windows follow them.
 */
export function mixSubredditWindows<I, W>(items: I[], windows: W[]): FeedEntry<I, W>[] {
  const taken = new Set(WINDOW_SLOTS.slice(0, windows.length));
  const out: FeedEntry<I, W>[] = [];
  let i = 0;
  let w = 0;
  for (let pos = 0; i < items.length || w < windows.length; pos++) {
    const windowHere = taken.has(pos) || pos >= WINDOW_SLOTS.length;
    if (w < windows.length && (windowHere || i >= items.length)) out.push({ window: windows[w++] });
    else out.push({ item: items[i++] });
  }
  return out;
}
