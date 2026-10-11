import { LOCAL_FEED_PREFIX } from '../constants';
import type { FeedSourceKind } from '../types';
import { rymMusicRecsProvider } from './rym-music-recs';
import type { LocalFeedProvider } from './types';

const LOCAL_FEED_PROVIDER_ID_RE = /^[a-z0-9_]+$/;

export type LocalFeedProviderRegistry = Record<string, LocalFeedProvider>;

export const LOCAL_FEED_PROVIDERS: LocalFeedProviderRegistry = {
  rym_music_recs: rymMusicRecsProvider,
};

export function parseLocalFeedUrl(url: string): string | null {
  if (!url.startsWith(LOCAL_FEED_PREFIX)) return null;
  const providerId = url.slice(LOCAL_FEED_PREFIX.length);
  if (!LOCAL_FEED_PROVIDER_ID_RE.test(providerId)) return null;
  return providerId;
}

export function inferFeedSourceKind(url: string): FeedSourceKind {
  return parseLocalFeedUrl(url) ? 'LOCAL' : 'RSS';
}

export function hasLocalFeedProvider(
  providerId: string,
  registry: LocalFeedProviderRegistry = LOCAL_FEED_PROVIDERS,
): boolean {
  return Object.prototype.hasOwnProperty.call(registry, providerId);
}

export function getLocalFeedProvider(
  providerId: string,
  registry: LocalFeedProviderRegistry = LOCAL_FEED_PROVIDERS,
): LocalFeedProvider | null {
  return hasLocalFeedProvider(providerId, registry) ? registry[providerId] : null;
}
