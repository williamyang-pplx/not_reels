import { z } from 'zod';
import { LOCAL_FEED_PREFIX } from './constants';
import { hasLocalFeedProvider, parseLocalFeedUrl } from './local-feeds/registry';

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
    }
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

export const CreateFeedSchema = z.object({
  name: z.string().min(1).max(100),
  url: FeedUrlSchema,
  topics: z.array(TopicSchema).min(1).max(10),
});

export const UpdateFeedSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  topics: z.array(TopicSchema).min(1).max(10).optional(),
  isActive: z.boolean().optional(),
});

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
