import type { FeedSourceKind } from './types';

export const FEED_SOURCE_KINDS = ['RSS', 'LOCAL'] as const satisfies readonly FeedSourceKind[];

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

export const PAGE_SIZE_DEFAULT = 100;
export const PAGE_SIZE_MAX = 100;
export const RELEVANT_FETCH_SIZE = 200;

export const MAX_ITEMS_PER_FEED = 30;

export const FETCH_ERROR_THRESHOLD = 5;
export const FETCH_CONCURRENCY = 12;

export const RYM_FEED_URL = 'local/rym_music_recs';
export const RYM_ITEMS_PER_REFRESH = 30;
export const STALE_SOURCE_RANK = 10_000;
