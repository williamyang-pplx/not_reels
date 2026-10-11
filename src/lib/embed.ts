export type EmbedKind = 'youtube' | 'reddit' | null;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'i.reddit.com',
]);

function parseUrl(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

export function detectEmbedKind(link: string): EmbedKind {
  const url = parseUrl(link);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return 'youtube';
  if (REDDIT_HOSTS.has(host)) return 'reddit';
  return null;
}

const VALID_ID = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeId(link: string): string | null {
  const url = parseUrl(link);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return VALID_ID.test(id) ? id : null;
  }

  const v = url.searchParams.get('v');
  if (v && VALID_ID.test(v)) return v;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live')) {
    const id = segments[1];
    if (VALID_ID.test(id)) return id;
  }

  return null;
}

const REDDIT_POST_ID = /^[a-z0-9]{5,12}$/;
const REDDIT_SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

export interface RedditPost {
  subreddit: string;
  postId: string;
  slug: string;
}

export function extractRedditPost(link: string): RedditPost | null {
  const url = parseUrl(link);
  if (!url) return null;
  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 4) return null;
  if (segments[0] !== 'r') return null;
  if (segments[2] !== 'comments') return null;

  const subreddit = segments[1];
  const postId = segments[3];
  const slug = segments[4] ?? '';

  if (!REDDIT_SUBREDDIT.test(subreddit)) return null;
  if (!REDDIT_POST_ID.test(postId)) return null;

  return { subreddit, postId, slug };
}
