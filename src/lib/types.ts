export type FeedType = 'FORUM' | 'BLOG';

export type FeedSourceKind = 'RSS' | 'LOCAL';

export type Topic = string;

export type FilterType = FeedType | 'SAVED';
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
  type: FeedType;
  topics: Topic[];
  isActive: boolean;
  fetchErrorCount: number;
  lastFetched: string | null;
  createdAt: string;
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
  feedType?: FeedType;
  feedTopics?: Topic[];
}

export interface SavedLink {
  id: string;
  url: string;
  title: string;
  topic: Topic;
  notes: string | null;
  savedAt: string;
}

export interface FilterState {
  type: FilterType;
  topic: FilterTopic;
}

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiError {
  error: { message: string; code: string };
}
