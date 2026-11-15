/** REDDIT: a subreddit shown as a Redlib window (src/redlib.ts), never fetched. */
export type FeedSourceKind = 'RSS' | 'LOCAL' | 'REDDIT';

export type Topic = string;

/** Which nav pill is active; derived from the path, never a URL param. */
export type FilterType = 'FEED' | 'SAVED';
export type FilterTopic = Topic | 'ALL';
export type SortOrder = 'recommended' | 'new' | 'random';

export interface TopicRecord {
  slug: string;
  label: string;
  createdAt: string;
}

export interface Feed {
  id: string;
  name: string;
  url: string;
  sourceKind: FeedSourceKind;
  topics: Topic[];
  isActive: boolean;
  fetchErrorCount: number;
  lastFetched: string | null;
  createdAt: string;
}

/** What a Reddit post shows besides its text. Stored as JSON in FeedItem.media; paths are same-origin Redlib paths. */
export interface RedditMedia {
  /** Every image, in order (one, or a gallery), e.g. /preview/pre/abc.jpeg?width=1080&… */
  images: string[];
  video: { src: string; poster: string | null } | null;
  /** A link post's target (a YouTube URL, an article), absolute http(s). */
  url: string | null;
  /** The net score as Redlib gives it ("18"), or null when the subreddit hides it. */
  score: string | null;
  comments: number | null;
}

export interface FeedItem {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  author: string | null;
  publishedAt: string;
  feedName?: string;
  feedUrl?: string;
  feedTopics?: Topic[];
  media?: RedditMedia | null;
}

export interface SavedLink {
  id: string;
  url: string;
  title: string;
  topic: Topic;
  notes: string | null;
  savedAt: string;
}

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiError {
  error: { message: string; code: string };
}
