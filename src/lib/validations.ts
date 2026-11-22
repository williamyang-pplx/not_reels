import { z } from 'zod';
import { LOCAL_FEED_PREFIX } from './constants';
import { detectEmbedKind } from './embed';
import { hasLocalFeedProvider, parseLocalFeedUrl } from './local-feeds/registry';
import { parseSubredditFeedUrl, subredditFeedUrl } from './reddit-feeds';
import { parseYouTubeChannelUrl } from './youtube-api';

function isYouTubeRssUrl(value: string): boolean {
  return new URL(value).pathname === '/feeds/videos.xml';
}

export const FeedUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.startsWith(LOCAL_FEED_PREFIX)) {
      const providerId = parseLocalFeedUrl(value);
      if (!providerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Local feed URL must use local/<provider_id>',
        });
        return;
      }
      if (!hasLocalFeedProvider(providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unknown local feed provider',
        });
      }
      return;
    }

    if (!z.string().url().safeParse(value).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid feed URL',
      });
      return;
    }

    // Reddit is read through Redlib windows: only a subreddit page works (its RSS feeds were shut down).
    if (detectEmbedKind(value) === 'reddit' && !parseSubredditFeedUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reddit feeds must be a subreddit URL, like https://www.reddit.com/r/listentothis/',
      });
    }

    // YouTube is read through the Data API: only a channel works. Its playlist and user RSS feeds stay plain RSS.
    if (detectEmbedKind(value) === 'youtube' && !isYouTubeRssUrl(value) && !parseYouTubeChannelUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'YouTube feeds must be a channel URL, like https://www.youtube.com/@name',
      });
    }
  })
  // One stored form per subreddit, so the duplicate check catches reddit.com/r/X vs www.reddit.com/r/x/.
  .transform((value) => {
    const sub = parseSubredditFeedUrl(value);
    return sub ? subredditFeedUrl(sub) : value;
  });
export const TopicSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9_]+$/, 'Topic slug must be uppercase letters, digits, or underscores');
export const TopicLabelSchema = z.string().min(1).max(50);

export const CreateTopicSchema = z.object({
  slug: TopicSchema,
  label: TopicLabelSchema,
});

export const ReorderTopicsSchema = z.object({
  slugs: z.array(TopicSchema).min(1),
});

/** 'YYYY-MM-DD' that is a real calendar day (a UTC day), or null for no bound. */
const YouTubeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Invalid date')
  .nullable();

/** endDate before startDate is rejected; either may be missing or null. */
const youTubeRangeOk = (v: { startDate?: string | null; endDate?: string | null }) =>
  !v.startDate || !v.endDate || v.startDate <= v.endDate;

const RANGE_ERROR = { message: 'End date is before start date', path: ['endDate'] };
const TOGGLES_ERROR = { message: 'Turn on Recent or Archive', path: ['recent'] };

export const CreateFeedSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: FeedUrlSchema,
    topics: z.array(TopicSchema).min(1).max(10),
    startDate: YouTubeDateSchema.optional(),
    endDate: YouTubeDateSchema.optional(),
    includeShorts: z.boolean().optional(),
    recent: z.boolean().optional(),
    archive: z.boolean().optional(),
  })
  .refine(youTubeRangeOk, RANGE_ERROR)
  .refine((v) => v.recent !== false || v.archive !== false, TOGGLES_ERROR);

export const UpdateFeedSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    topics: z.array(TopicSchema).min(1).max(10).optional(),
    isActive: z.boolean().optional(),
    /** YOUTUBE feeds only. */
    url: FeedUrlSchema.optional(),
    startDate: YouTubeDateSchema.optional(),
    endDate: YouTubeDateSchema.optional(),
    includeShorts: z.boolean().optional(),
    recent: z.boolean().optional(),
    archive: z.boolean().optional(),
  })
  // Both toggles off is checked against the stored settings in the PATCH handler.
  .refine(youTubeRangeOk, RANGE_ERROR);

export const CreateSavedLinkSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(200),
  topic: TopicSchema,
  notes: z.string().max(1000).optional(),
});

export const UpdateSavedLinkSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  topic: TopicSchema.optional(),
  notes: z.string().max(1000).optional(),
});

export const RefreshBodySchema = z.object({
  feedId: z.string().optional(),
});

export const ArchiveQuerySchema = z.object({
  url: z.string().url(),
});

export type CreateFeedInput = z.infer<typeof CreateFeedSchema>;
export type UpdateFeedInput = z.infer<typeof UpdateFeedSchema>;
export type CreateSavedLinkInput = z.infer<typeof CreateSavedLinkSchema>;
export type UpdateSavedLinkInput = z.infer<typeof UpdateSavedLinkSchema>;
export type CreateTopicInput = z.infer<typeof CreateTopicSchema>;
