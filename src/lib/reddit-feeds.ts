import { REDDIT_HOSTS, type RedditPost } from './embed';
import type { FeedFetcher, NormalizedItem, RawRssItem } from './rss-fetcher';
import type { RedditMedia } from './types';
import { decodeEntities } from './utils';

/**
 * Subreddit feeds (sourceKind REDDIT) are read through a self-hosted Redlib (src/redlib.ts): a refresh turns each
 * subreddit's posts into feed items, and a post or subreddit opens in the Redlib sheet on tap. These helpers
 * recognise subreddit URLs, build the Redlib paths, and read Redlib's output.
 */

export interface SubredditFeed {
  /** Lowercase. */
  subreddit: string;
  /** hot, new, rising, top or controversial. */
  sort: string;
}

// A subreddit page: /r/<sub>, /r/<sub>/, /r/<sub>/<sort>, /r/<sub>/<sort>/.
const SUBREDDIT_PAGE_PATH = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/(hot|new|rising|top|controversial))?\/?$/i;
// Its old RSS feed: /r/<sub>.rss, /r/<sub>/.rss, /r/<sub>/<sort>.rss, /r/<sub>/<sort>/.rss.
const SUBREDDIT_RSS_PATH = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/(hot|new|rising|top|controversial))?\/?\.rss$/i;

function parseSubredditPath(feedUrl: string, path: RegExp): SubredditFeed | null {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }
  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase()) || url.search) return null;
  const match = path.exec(url.pathname);
  if (!match) return null;
  return { subreddit: match[1].toLowerCase(), sort: (match[2] ?? 'hot').toLowerCase() };
}

/** A subreddit page URL on a Reddit host with no query string, or null if the URL is anything else. */
export function parseSubredditFeedUrl(feedUrl: string): SubredditFeed | null {
  return parseSubredditPath(feedUrl, SUBREDDIT_PAGE_PATH);
}

/** A subreddit's old RSS feed URL, or null. Only the boot migration reads these; new feeds must be page URLs. */
export function parseLegacySubredditRssUrl(feedUrl: string): SubredditFeed | null {
  return parseSubredditPath(feedUrl, SUBREDDIT_RSS_PATH);
}

/** The one stored form of a subreddit feed's URL: https://www.reddit.com/r/<sub>/, with /<sort>/ unless hot. */
export function subredditFeedUrl(feed: SubredditFeed): string {
  return feed.sort === 'hot' ? `https://www.reddit.com/r/${feed.subreddit}/` : `https://www.reddit.com/r/${feed.subreddit}/${feed.sort}/`;
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

export type PageFetcher = (url: string) => Promise<string>;

type ListingExtras = Pick<RedditMedia, 'url' | 'score' | 'comments'>;

const NO_EXTRAS: ListingExtras = { url: null, score: null, comments: null };

// Every post in Redlib's listing starts <div class="post" id="…"> or <div class="post stickied" id="…">.
const LISTING_POST = /(?=<div class="post(?: stickied)?" id=")/;
const THREAD_PATH = /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/([a-z0-9]+)\//i;

/** A thread's post ID from its path. RSS and listing spell non-ASCII slugs differently, so posts are matched on it. */
function postId(path: string): string | null {
  return THREAD_PATH.exec(path)?.[1].toLowerCase() ?? null;
}

/** A Redlib URL or path (absolute when Redlib has REDLIB_FULL_URL) as a same-origin path with its query. */
function redlibPath(src: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(src), base);
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

/**
 * The post media in one Redlib RSS item's <content:encoded>: every <img> src (a gallery's images, in order) and the
 * first <video>'s <source> and poster, as same-origin paths.
 */
export function parseRssMedia(contentHtml: string, base: string): Pick<RedditMedia, 'images' | 'video'> {
  const images = Array.from(contentHtml.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi), (m) => redlibPath(m[1], base)).filter(
    (p): p is string => p !== null,
  );
  let video: RedditMedia['video'] = null;
  const tag = /<video\b([^>]*)>([\s\S]*?)<\/video>/i.exec(contentHtml);
  const src = tag && /<source\b[^>]*\ssrc="([^"]+)"/i.exec(tag[2]);
  const videoPath = src && redlibPath(src[1], base);
  if (tag && videoPath) {
    const poster = /\sposter="([^"]+)"/i.exec(tag[1]);
    video = { src: videoPath, poster: poster ? redlibPath(poster[1], base) : null };
  }
  return { images, video };
}

/**
 * Per post in Redlib's HTML listing: the link-post URL, the score and the comment count, keyed by post ID.
 * This reads Redlib's markup, so a Redlib upgrade can change it; a post it can't read just gets nulls.
 */
export function parseListingExtras(html: string): Map<string, ListingExtras> {
  const out = new Map<string, ListingExtras>();
  for (const chunk of html.split(LISTING_POST).slice(1)) {
    // Flair links are /r/<sub>/search?…, so the first /comments/ href is the permalink.
    const permalink = /href="(\/r\/[^"/]+\/comments\/[^"]+)"/.exec(chunk);
    if (!permalink) continue;
    const thumb = /<a\b[^>]*class="post_thumbnail[^"]*"[^>]*href="([^"]+)"|<a\b[^>]*href="([^"]+)"[^>]*class="post_thumbnail/.exec(chunk);
    const thumbHref = thumb ? decodeEntities(thumb[1] ?? thumb[2]) : '';
    const score = /class="post_score" title="([^"]*)"/.exec(chunk)?.[1];
    const comments = /class="post_comments"[^>]*>[\s\S]*?(\d[\d,]*)\s+comments?/.exec(chunk)?.[1];
    const id = postId(decodeEntities(permalink[1]));
    if (!id) continue;
    out.set(id, {
      url: /^https?:\/\//i.test(thumbHref) ? thumbHref : null,
      score: score && score !== 'Hidden' ? score : null,
      comments: comments ? Number(comments.replace(/,/g, '')) : null,
    });
  }
  return out;
}

/** The post's text as plain text: Redlib's markdown HTML without media, the lone "Comments" link, comments or tags. */
function postText(contentHtml: string): string | null {
  const html = contentHtml
    .replace(/<video\b[\s\S]*?<\/video>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (/^\s*(<br\s*\/?>\s*)*<a\b[^>]*>\s*Comments\s*<\/a>\s*$/i.test(html)) return null;
  const text = decodeEntities(
    html
      .replace(/<\/(p|li|h\d|blockquote|pre)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/**
 * One refresh of a subreddit feed from Redlib: its RSS (text, images, video) and its HTML listing (link, score,
 * comments), merged by permalink. Links become https://www.reddit.com permalinks so Save/Hide/archive key on them.
 * Redlib asks Reddit for the subreddit the same way for both; RSS is only the format it answers in.
 */
export async function fetchSubredditItems(
  feed: SubredditFeed,
  base: string,
  fetchRss: FeedFetcher,
  fetchPage: PageFetcher,
  now: Date,
): Promise<NormalizedItem[]> {
  const [parsed, html] = await Promise.all([
    fetchRss(`${base}/r/${feed.subreddit}/${feed.sort}.rss`),
    fetchPage(base + redlibSubredditPath(feed)),
  ]);
  const extras = parseListingExtras(html);
  const posts: { raw: RawRssItem; id: string; content: string }[] = [];
  for (const item of parsed.items) {
    const path = item.link ? redlibPath(item.link, base)?.split('?')[0] : null;
    const id = path && postId(path);
    if (!path || !id) continue;
    posts.push({ raw: { ...item, guid: path, link: `https://www.reddit.com${path}` }, id, content: item['content:encoded'] ?? '' });
  }
  if (parsed.items.length > 0 && posts.length === 0) throw new Error(`No Reddit posts in Redlib's feed for r/${feed.subreddit}`);
  const { normalizeAll } = await import('./rss-fetcher');
  return normalizeAll(
    posts.map((p) => p.raw),
    now,
  ).map((item, i) => {
    const { id, content } = posts[i];
    const media: RedditMedia = { ...parseRssMedia(content, base), ...(extras.get(id) ?? NO_EXTRAS) };
    return { ...item, summary: postText(content), media: JSON.stringify(media) };
  });
}
