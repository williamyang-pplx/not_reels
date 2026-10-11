import { describe, expect, it } from 'vitest';
import type { RecommendationItem } from '../src/lib/recommendation';
import { recommendItems } from '../src/lib/recommendation';

function item(input: {
  id: string;
  feedId: string;
  topic: string;
  type?: 'FORUM' | 'BLOG';
  publishedAt: string;
  sourceRank?: number | null;
}): RecommendationItem {
  return {
    id: input.id,
    feedId: input.feedId,
    publishedAt: new Date(input.publishedAt),
    sourceRank: input.sourceRank ?? null,
    feed: {
      name: `Feed ${input.feedId}`,
      topic: input.topic,
      type: input.type ?? 'FORUM',
    },
  };
}

describe('recommendItems', () => {
  it('prefers stronger source popularity over freshness with default weights', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const ranked = recommendItems(
      [
        item({
          id: 'popular-but-older',
          feedId: 'f1',
          topic: 'TECHNOLOGY',
          sourceRank: 0,
          publishedAt: '2026-04-16T00:00:00Z',
        }),
        item({
          id: 'fresh-but-lower-rank',
          feedId: 'f1',
          topic: 'TECHNOLOGY',
          sourceRank: 10,
          publishedAt: '2026-04-17T11:30:00Z',
        }),
      ],
      {
        now,
        applyTopicBalance: false,
      },
    );

    expect(ranked.map((x) => x.id)).toEqual(['popular-but-older', 'fresh-but-lower-rank']);
  });

  it('prefers fresher items when recency weight dominates', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const ranked = recommendItems(
      [
        item({
          id: 'old',
          feedId: 'f1',
          topic: 'TECHNOLOGY',
          sourceRank: 0,
          publishedAt: '2026-04-16T12:00:00Z',
        }),
        item({
          id: 'new',
          feedId: 'f1',
          topic: 'TECHNOLOGY',
          sourceRank: 10,
          publishedAt: '2026-04-17T11:30:00Z',
        }),
      ],
      {
        now,
        applyTopicBalance: false,
        weights: { popularity: 0, recency: 1, topicAffinity: 0, feedVelocity: 0 },
      },
    );

    expect(ranked.map((x) => x.id)).toEqual(['new', 'old']);
  });

  it('boosts topics with more saved-link history', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const ranked = recommendItems(
      [
        item({
          id: 'news',
          feedId: 'f1',
          topic: 'NEWS',
          publishedAt: '2026-04-17T11:00:00Z',
        }),
        item({
          id: 'music',
          feedId: 'f2',
          topic: 'MUSIC',
          publishedAt: '2026-04-17T11:00:00Z',
        }),
      ],
      {
        now,
        applyTopicBalance: false,
        topicCounts: { MUSIC: 9, NEWS: 1 },
        weights: { popularity: 0, recency: 0, topicAffinity: 1, feedVelocity: 0 },
      },
    );

    expect(ranked.map((x) => x.id)).toEqual(['music', 'news']);
  });

  it('uses soft balancing to avoid long single-topic prefixes', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const candidates: RecommendationItem[] = [
      item({ id: 't1', feedId: 't1', topic: 'TECHNOLOGY', publishedAt: '2026-04-17T11:00:00Z' }),
      item({ id: 't2', feedId: 't2', topic: 'TECHNOLOGY', publishedAt: '2026-04-17T10:59:00Z' }),
      item({ id: 't3', feedId: 't3', topic: 'TECHNOLOGY', publishedAt: '2026-04-17T10:58:00Z' }),
      item({ id: 't4', feedId: 't4', topic: 'TECHNOLOGY', publishedAt: '2026-04-17T10:57:00Z' }),
      item({ id: 't5', feedId: 't5', topic: 'TECHNOLOGY', publishedAt: '2026-04-17T10:56:00Z' }),
      item({ id: 'n1', feedId: 'n1', topic: 'NEWS', publishedAt: '2026-04-17T10:55:00Z' }),
      item({ id: 'n2', feedId: 'n2', topic: 'NEWS', publishedAt: '2026-04-17T10:54:00Z' }),
    ];

    const unbalanced = recommendItems(candidates, {
      now,
      applyTopicBalance: false,
      topicCounts: { TECHNOLOGY: 20, NEWS: 1 },
      weights: { popularity: 0, recency: 0, topicAffinity: 1, feedVelocity: 0 },
    });
    expect(unbalanced.slice(0, 3).every((x) => x.feed.topic === 'TECHNOLOGY')).toBe(true);

    const balanced = recommendItems(candidates, {
      now,
      applyTopicBalance: true,
      softBalanceStrength: 3,
      topicCounts: { TECHNOLOGY: 20, NEWS: 1 },
      weights: { popularity: 0, recency: 0, topicAffinity: 1, feedVelocity: 0 },
    });
    expect(balanced.slice(0, 3).some((x) => x.feed.topic === 'NEWS')).toBe(true);
  });
});
