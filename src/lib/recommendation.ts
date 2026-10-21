export interface RecommendationFeed {
  name: string;
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
}

export interface RecommendOptions {
  now?: Date;
  topicCounts?: Record<string, number>;
  weights?: Partial<RecommendationWeights>;
  /** Score lost per item already placed from the same feed. */
  feedRepeatPenalty?: number;
  /** The most score a post can lose for being older than `STALE_AFTER_DAYS`. */
  stalePenalty?: number;
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
};

const RECENCY_HALF_LIFE_HOURS = 36;
const POPULARITY_RANK_HALF_LIFE = 4;
const DEFAULT_TOPIC_AFFINITY = 0.5;
const DEFAULT_FEED_REPEAT_PENALTY = 0.2;
const DEFAULT_BALANCE_STRENGTH = 1;
const DEFAULT_TARGET_BLEND = 0.3;
const STALE_AFTER_DAYS = 60;
const STALE_HALF_LIFE_DAYS = 30;
const DEFAULT_STALE_PENALTY = 0.5;

function ageHours(publishedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
}

function recencyScore(item: RecommendationItem, now: Date): number {
  const decay = Math.LN2 / RECENCY_HALF_LIFE_HOURS;
  return Math.exp(-decay * ageHours(item.publishedAt, now));
}

/**
 * 0 for a post from the last two months, rising toward 1 after that (half of it 30 days past the cutoff). Large
 * enough at full weight that a year-old post sits behind the recent ones even when feed spread or topic balance
 * favor it, without dropping it from the list.
 */
function staleness(item: RecommendationItem, now: Date): number {
  const daysPast = ageHours(item.publishedAt, now) / 24 - STALE_AFTER_DAYS;
  return daysPast <= 0 ? 0 : 1 - Math.exp(-(Math.LN2 / STALE_HALF_LIFE_DAYS) * daysPast);
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

function compareItems(a: RecommendationItem, b: RecommendationItem): number {
  const aRank = a.sourceRank ?? Number.MAX_SAFE_INTEGER;
  const bRank = b.sourceRank ?? Number.MAX_SAFE_INTEGER;
  const rankDiff = aRank - bRank;
  if (rankDiff !== 0) return rankDiff;

  const publishedDiff = b.publishedAt.getTime() - a.publishedAt.getTime();
  if (publishedDiff !== 0) return publishedDiff;
  return a.id.localeCompare(b.id);
}

/**
 * Greedy, one position at a time: the best adjusted score wins. A feed loses `feedRepeatPenalty` for each item it
 * already has above, so the front of the list cycles through sources before any repeats. With topic balance on, a
 * topic also loses `strength × (projected share − target share)` once it is over its target. The target leans to an
 * equal share per topic (`targetBlend` of the observed share), so a topic with few feeds still gets front slots.
 */
function diversify<T extends RecommendationItem>(
  scored: ScoredItem<T>[],
  feedRepeatPenalty: number,
  topicBalance: { strength: number; targetBlend: number } | null,
): T[] {
  const topics = scored.map((entry) => entry.item.feed.topic);
  const uniqueTopics = [...new Set(topics)];
  const uniform = 1 / uniqueTopics.length;

  const targetShareByTopic: Record<string, number> = {};
  if (topicBalance) {
    const observedCounts: Record<string, number> = {};
    for (const topic of topics) observedCounts[topic] = (observedCounts[topic] ?? 0) + 1;
    for (const topic of uniqueTopics) {
      const observed = observedCounts[topic] / scored.length;
      targetShareByTopic[topic] = (topicBalance.targetBlend * observed) + ((1 - topicBalance.targetBlend) * uniform);
    }
  }

  const pickedByFeed: Record<string, number> = {};
  const pickedByTopic: Record<string, number> = {};
  const remaining = [...scored];
  const ranked: T[] = [];

  while (remaining.length > 0) {
    const nextPosition = ranked.length + 1;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const { item, baseScore } = remaining[i];
      let adjusted = baseScore - (feedRepeatPenalty * (pickedByFeed[item.feedId] ?? 0));
      if (topicBalance) {
        const projectedShare = ((pickedByTopic[item.feed.topic] ?? 0) + 1) / nextPosition;
        const target = targetShareByTopic[item.feed.topic] ?? uniform;
        adjusted -= topicBalance.strength * Math.max(0, projectedShare - target);
      }

      if (adjusted > bestScore || (adjusted === bestScore && compareItems(item, remaining[bestIndex].item) < 0)) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    pickedByFeed[picked.item.feedId] = (pickedByFeed[picked.item.feedId] ?? 0) + 1;
    pickedByTopic[picked.item.feed.topic] = (pickedByTopic[picked.item.feed.topic] ?? 0) + 1;
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
  const applyTopicBalance = options.applyTopicBalance ?? true;
  const stalePenalty = options.stalePenalty ?? DEFAULT_STALE_PENALTY;

  const topicAffinity = topicAffinityByTopic(topicCounts, items.map((item) => item.feed.topic));

  const scored = items.map((item) => ({
    item,
    baseScore:
      (weights.popularity * popularityScore(item, now))
      + (weights.recency * recencyScore(item, now))
      + (weights.topicAffinity * (topicAffinity[item.feed.topic] ?? DEFAULT_TOPIC_AFFINITY))
      - (stalePenalty * staleness(item, now)),
  }));

  return diversify(
    scored,
    options.feedRepeatPenalty ?? DEFAULT_FEED_REPEAT_PENALTY,
    applyTopicBalance
      ? {
        strength: options.softBalanceStrength ?? DEFAULT_BALANCE_STRENGTH,
        targetBlend: options.targetBlend ?? DEFAULT_TARGET_BLEND,
      }
      : null,
  );
}
