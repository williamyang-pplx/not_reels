import type { FeedSourceKind } from '../types';

export interface LocalFeedRecord {
  id: string;
  name: string;
  url: string;
  sourceKind: FeedSourceKind;
}

export interface LocalFeedContext {
  feed: LocalFeedRecord;
  now: Date;
}

export interface LocalFeedItemInput {
  guid: string;
  title: string;
  link: string;
  summary?: string | null;
  author?: string | null;
  publishedAt?: Date | string | null;
  sourceRank?: number | null;
}

export type LocalFeedProvider = (
  context: LocalFeedContext,
) => Promise<LocalFeedItemInput[]> | LocalFeedItemInput[];
