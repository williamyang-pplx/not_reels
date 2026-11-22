/** REDDIT: a subreddit read through Redlib (src/redlib.ts). YOUTUBE: a channel read through the YouTube Data API. */
export type FeedSourceKind = 'RSS' | 'LOCAL' | 'REDDIT' | 'YOUTUBE';

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
  /** Set only when sourceKind is YOUTUBE. */
  youtube: YouTubeFeedInfo | null;
}

/** A YOUTUBE feed's settings as the API takes them. */
export interface YouTubeSettings {
  /** Show the channel's newest RSS videos. */
  recent: boolean;
  /** Pick videos from the channel's archive on each refresh. */
  archive: boolean;
  includeShorts: boolean;
  /** 'YYYY-MM-DD' UTC day, or null for no lower bound; filters archive picks only. */
  startDate: string | null;
  /** 'YYYY-MM-DD' UTC day (inclusive), or null for no upper bound; filters archive picks only. */
  endDate: string | null;
}

/** A YOUTUBE feed's settings as the API returns them: the settings plus the channel's archive. */
export interface YouTubeFeedInfo extends YouTubeSettings {
  /** Videos in YouTubeVideo for this channel. */
  archiveSize: number;
  /** The back catalog fill finished. */
  archiveFilled: boolean;
  /** The last fill's failure reason, or null. */
  archiveError: string | null;
}

/** A YOUTUBE feed's settings as stored on Feed: ms, publishedBefore exclusive. */
export interface YouTubeFeedOptions {
  recent: boolean;
  archive: boolean;
  includeShorts: boolean;
  publishedAfter: number | null;
  publishedBefore: number | null;
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
  /** A YouTube video's upload date (ISO), shown beside the card's time; null otherwise. */
  uploadedAt?: string | null;
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
