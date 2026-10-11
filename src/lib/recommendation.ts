import type { FeedType } from './types';

export interface RecommendationFeed {
  name: string;
  type: FeedType | string;
  topic: string;
}

export interface RecommendationItem {
  id: string;
  feedId: string;
  publishedAt: Date;
  sourceRank?: number | null;
  feed: RecommendationFeed;
}

export interface RecommendationWeights {
  popularity: number;
  recency: number;
  topicAffinity: number;
  feedVelocity: number;
}

export interface RecommendOptions {
  now?: Date;
  topicCounts?: Record<string, number>;
  weights?: Partial<RecommendationWeights>;
  softBalanceStrength?: number;
  targetBlend?: number;
  applyTopicBalance?: boolean;
}

interface ScoredItem<T extends RecommendationItem> {
  item: T;
  baseScore: number;
}

const DEFAULT_WEIGHTS: RecommendationWeights = {
  popularity: 0.6,
  recency: 0.15,
  topicAffinity: 0.15,
  feedVelocity: 0.1,
};

const FORUM_HALF_LIFE_HOURS = 18;
const BLOG_HALF_LIFE_HOURS = 72;
const POPULARITY_RANK_HALF_LIFE = 4;
const DEFAULT_TOPIC_AFFINITY = 0.5;
const DEFAULT_BALANCE_STRENGTH = 0.25;
const DEFAULT_TARGET_BLEND = 0.7;

function ageHours(publishedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
}

function recencyScore(item: RecommendationItem, now: Date): number {
  const halfLife = item.feed.type === 'BLOG'
    ? BLOG_HALF_LIFE_HOURS
    : FORUM_HALF_LIFE_HOURS;
  const decay = Math.LN2 / halfLife;
  return Math.exp(-decay * ageHours(item.publishedAt, now));
}

function popularityScore(item: RecommendationItem, now: Date): number {
  if (typeof item.sourceRank === 'number' && Number.isFinite(item.sourceRank) && item.sourceRank >= 0) {
    const decay = Math.LN2 / POPULARITY_RANK_HALF_LIFE;
    return Math.exp(-decay * item.sourceRank);
  }
  return recencyScore(item, now);
}

function topicAffinityByTopic(
  topicCounts: Record<string, number>,
  topics: string[],
): Record<string, number> {
  const uniqueTopics = new Set(topics);
  const topicBuckets = Math.max(uniqueTopics.size, 1);
  const total = Object.values(topicCounts).reduce((sum, count) => sum + count, 0);

  if (total === 0) {
    const neutral: Record<string, number> = {};
    for (const topic of uniqueTopics) neutral[topic] = DEFAULT_TOPIC_AFFINITY;
    return neutral;
  }

  const affinity: Record<string, number> = {};
  for (const topic of uniqueTopics) {
    const count = topicCounts[topic] ?? 0;
    affinity[topic] = (count + 1) / (total + topicBuckets);
  }
  return affinity;
}

function feedVelocityByFeed<T extends RecommendationItem>(items: T[]): Record<string, number> {
  const feedCounts = new Map<string, number>();
  for (const item of items) {
    feedCounts.set(item.feedId, (feedCounts.get(item.feedId) ?? 0) + 1);
  }
  const maxCount = Math.max(...feedCounts.values(), 1);
  const velocity: Record<string, number> = {};
  for (const [feedId, count] of feedCounts.entries()) {
    velocity[feedId] = count / maxCount;
  }
  return velocity;
}

function compareItems(a: RecommendationItem, b: RecommendationItem): number {
  const aRank = a.sourceRank ?? Number.MAX_SAFE_INTEGER;
  const bRank = b.sourceRank ?? Number.MAX_SAFE_INTEGER;
  const rankDiff = aRank - bRank;
  if (rankDiff !== 0) return rankDiff;

  const publishedDiff = b.publishedAt.getTime() - a.publishedAt.getTime();
  if (publishedDiff !== 0) return publishedDiff;
  return a.id.localeCompare(b.id);
}

function applySoftTopicBalance<T extends RecommendationItem>(
  scored: ScoredItem<T>[],
  strength: number,
  targetBlend: number,
): T[] {
  if (scored.length <= 2) {
    return scored
      .slice()
      .sort((a, b) => (b.baseScore - a.baseScore) || compareItems(a.item, b.item))
      .map((entry) => entry.item);
  }

  const total = scored.length;
  const allTopics = scored.map((entry) => entry.item.feed.topic);
  const uniqueTopics = [...new Set(allTopics)];
  const uniform = 1 / uniqueTopics.length;

  const observedByTopic: Record<string, number> = {};
  for (const topic of allTopics) {
    observedByTopic[topic] = (observedByTopic[topic] ?? 0) + 1;
  }
  for (const topic of uniqueTopics) {
    observedByTopic[topic] = observedByTopic[topic] / total;
  }

  const targetShareByTopic: Record<string, number> = {};
  for (const topic of uniqueTopics) {
    const observed = observedByTopic[topic] ?? 0;
    targetShareByTopic[topic] = (targetBlend * observed) + ((1 - targetBlend) * uniform);
  }

  const selectedCounts: Record<string, number> = {};
  const remaining = [...scored];
  const ranked: T[] = [];

  while (remaining.length > 0) {
    const nextPosition = ranked.length + 1;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const topic = candidate.item.feed.topic;
      const projectedCount = (selectedCounts[topic] ?? 0) + 1;
      const projectedShare = projectedCount / nextPosition;
      const target = targetShareByTopic[topic] ?? uniform;
      const penalty = strength * Math.max(0, projectedShare - target);
      const adjusted = candidate.baseScore - penalty;

      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
        continue;
      }
      if (adjusted === bestScore) {
        const currentBest = remaining[bestIndex];
        if (compareItems(candidate.item, currentBest.item) < 0) {
          bestIndex = i;
        }
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    const pickedTopic = picked.item.feed.topic;
    selectedCounts[pickedTopic] = (selectedCounts[pickedTopic] ?? 0) + 1;
    ranked.push(picked.item);
  }

  return ranked;
}

export function recommendItems<T extends RecommendationItem>(
  items: T[],
  options: RecommendOptions = {},
): T[] {
  if (items.length <= 1) return items;

  const now = options.now ?? new Date();
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const topicCounts = options.topicCounts ?? {};
  const softBalanceStrength = options.softBalanceStrength ?? DEFAULT_BALANCE_STRENGTH;
  const targetBlend = options.targetBlend ?? DEFAULT_TARGET_BLEND;
  const applyTopicBalance = options.applyTopicBalance ?? true;

  const topics = items.map((item) => item.feed.topic);
  const topicAffinity = topicAffinityByTopic(topicCounts, topics);
  const velocityByFeed = feedVelocityByFeed(items);

  const scored = items.map((item) => {
    const popularity = popularityScore(item, now);
    const recency = recencyScore(item, now);
    const affinity = topicAffinity[item.feed.topic] ?? DEFAULT_TOPIC_AFFINITY;
    const velocity = velocityByFeed[item.feedId] ?? 0;

    return {
      item,
      baseScore:
        (weights.popularity * popularity)
        + (weights.recency * recency)
        + (weights.topicAffinity * affinity)
        + (weights.feedVelocity * velocity),
    };
  });

  if (!applyTopicBalance) {
    return scored
      .sort((a, b) => (b.baseScore - a.baseScore) || compareItems(a.item, b.item))
      .map((entry) => entry.item);
  }

  return applySoftTopicBalance(scored, softBalanceStrength, targetBlend);
}
