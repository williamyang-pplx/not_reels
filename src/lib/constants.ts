import type { FeedSourceKind } from './types';

export const FEED_SOURCE_KINDS = ['RSS', 'LOCAL', 'REDDIT', 'YOUTUBE'] as const satisfies readonly FeedSourceKind[];

export const LOCAL_FEED_PREFIX = 'local/';

export const DEFAULT_TOPICS: { slug: string; label: string }[] = [
  { slug: 'NEWS', label: 'News' },
  { slug: 'MUSIC', label: 'Music' },
  { slug: 'LITERATURE', label: 'Literature' },
  { slug: 'TECHNOLOGY', label: 'Tech' },
  { slug: 'SCIENCE', label: 'Science' },
  { slug: 'CULTURE', label: 'Culture' },
  { slug: 'POLITICS', label: 'Politics' },
  { slug: 'OTHER', label: 'Other' },
];

export const PAGE_SIZE_DEFAULT = 50; // New: cards per page; fewer cards (and images) on the first paint
export const PAGE_SIZE_MAX = 100;
export const RANKED_LIST_SIZE = 300; // Hot and Shuffle: posts ranked or shuffled and shown, all on one page

export const MAX_ITEMS_PER_FEED = 30;

/** Archive picks per YOUTUBE refresh; recent RSS videos (at most 15) come on top. */
export const YOUTUBE_ARCHIVE_PICKS = 30;
/** Most playlistItems pages (50 videos, 1 quota unit each) one channel fill reads per playlist: 20,000 videos. */
export const YOUTUBE_FILL_MAX_PAGES = 400;

export const FETCH_CONCURRENCY = 12;

export const RYM_FEED_URL = 'local/rym_music_recs';
export const RYM_ITEMS_PER_REFRESH = 30;
export const STALE_SOURCE_RANK = 10_000;
