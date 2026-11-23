export interface RecommendationFeed {
  name: string;
  topic: string;
}

export interface RecommendationItem {
  id: string;
  feedId: string;
  publishedAt: Date;
  sourceRank?: number | null;
  /** What Hot balances: 'YOUTUBE', 'REDDIT', or a topic slug. */
  bucket: string;
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
  applyBucketBalance?: boolean;
  /** Seeds the per-item noise; without it there is no noise. */
  seed?: number;
  /** How much the noise moves each score (default 0.07). */
  noiseScale?: number;
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
const DEFAULT_NOISE_SCALE = 0.07; // noise sd ≈ 0.09, about the popularity gap between rank 0 and rank 1

function ageHours(publishedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
}

function recencyScore(item: RecommendationItem, now: Date): number {
  const decay = Math.LN2 / RECENCY_HALF_LIFE_HOURS;
  return Math.exp(-decay * ageHours(item.publishedAt, now));
}

/**
 * 0 for a post from the last two months, rising toward 1 after that (half of it 30 days past the cutoff). Large
 * enough at full weight that a year-old post sits behind the recent ones even when feed spread or bucket balance
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

/**
 * A Gumbel(0, 1) draw that depends only on (seed, id): FNV-1a of `${seed}:${id}`, finished with murmur3's fmix32 so
 * ids that differ in their last characters still get unrelated draws. Keyed by id, an item keeps its draw while the
 * pool around it changes (a save, a hide).
 */
function gumbel(seed: number, id: string): number {
  const key = `${seed}:${id}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const u = ((h >>> 0) + 0.5) / 4294967296;
  return -Math.log(-Math.log(u));
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
 * already has above, so the front of the list cycles through sources before any repeats. With bucket balance on, a
 * bucket also loses `strength × (projected share − target share)` once it is over its target. The target leans to an
 * equal share per bucket (`targetBlend` of the observed share), so a bucket with few feeds still gets front slots.
 */
function diversify<T extends RecommendationItem>(
  scored: ScoredItem<T>[],
  feedRepeatPenalty: number,
  bucketBalance: { strength: number; targetBlend: number } | null,
): T[] {
  const buckets = scored.map((entry) => entry.item.bucket);
  const uniqueBuckets = [...new Set(buckets)];
  const uniform = 1 / uniqueBuckets.length;

  const targetShareByBucket: Record<string, number> = {};
  if (bucketBalance) {
    const observedCounts: Record<string, number> = {};
    for (const bucket of buckets) observedCounts[bucket] = (observedCounts[bucket] ?? 0) + 1;
    for (const bucket of uniqueBuckets) {
      const observed = observedCounts[bucket] / scored.length;
      targetShareByBucket[bucket] = (bucketBalance.targetBlend * observed) + ((1 - bucketBalance.targetBlend) * uniform);
    }
  }

  const pickedByFeed: Record<string, number> = {};
  const pickedByBucket: Record<string, number> = {};
  const remaining = [...scored];
  const ranked: T[] = [];

  while (remaining.length > 0) {
    const nextPosition = ranked.length + 1;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const { item, baseScore } = remaining[i];
      let adjusted = baseScore - (feedRepeatPenalty * (pickedByFeed[item.feedId] ?? 0));
      if (bucketBalance) {
        const projectedShare = ((pickedByBucket[item.bucket] ?? 0) + 1) / nextPosition;
        const target = targetShareByBucket[item.bucket] ?? uniform;
        adjusted -= bucketBalance.strength * Math.max(0, projectedShare - target);
      }

      if (adjusted > bestScore || (adjusted === bestScore && compareItems(item, remaining[bestIndex].item) < 0)) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    pickedByFeed[picked.item.feedId] = (pickedByFeed[picked.item.feedId] ?? 0) + 1;
    pickedByBucket[picked.item.bucket] = (pickedByBucket[picked.item.bucket] ?? 0) + 1;
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
  const applyBucketBalance = options.applyBucketBalance ?? true;
  const { seed } = options;
  const noiseScale = options.noiseScale ?? DEFAULT_NOISE_SCALE;
  const stalePenalty = options.stalePenalty ?? DEFAULT_STALE_PENALTY;

  const topicAffinity = topicAffinityByTopic(topicCounts, items.map((item) => item.feed.topic));

  const scored = items.map((item) => ({
    item,
    baseScore:
      (weights.popularity * popularityScore(item, now))
      + (weights.recency * recencyScore(item, now))
      + (weights.topicAffinity * (topicAffinity[item.feed.topic] ?? DEFAULT_TOPIC_AFFINITY))
      - (stalePenalty * staleness(item, now))
      + (seed === undefined ? 0 : noiseScale * gumbel(seed, item.id)),
  }));

  return diversify(
    scored,
    options.feedRepeatPenalty ?? DEFAULT_FEED_REPEAT_PENALTY,
    applyBucketBalance
      ? {
        strength: options.softBalanceStrength ?? DEFAULT_BALANCE_STRENGTH,
        targetBlend: options.targetBlend ?? DEFAULT_TARGET_BLEND,
      }
      : null,
  );
}
