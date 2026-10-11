import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { FEED_TYPES, FEED_TYPE_LABELS } from '../lib/constants';
import type { FeedDTO, FeedItemDTO, SavedLinkDTO } from '../lib/queries';
import type { FilterType, SortOrder, TopicRecord } from '../lib/types';
import { assets } from '../assets';
import {
  EmptyState,
  FeedCard,
  Modal,
  SavedLinkCard,
  TopicBadge,
  TopicCheckboxList,
  TypeBadge,
  inputClass,
} from './components';

const TYPE_OPTIONS: { value: FilterType; label: string }[] = [
  { value: 'FORUM', label: 'Forums' },
  { value: 'BLOG', label: 'Blogs/Videos' },
  { value: 'SAVED', label: 'Saved' },
];

const SORT_LABELS: Record<SortOrder, string> = { recommended: 'Hot', new: 'New', random: 'Random' };

/** URL for a (type, topic) pair, exactly as the NavBar builds it (spec §8.2). */
export function viewHref(type: FilterType, topic: string): string {
  const path = type === 'SAVED' ? '/saved' : '/';
  const sp = new URLSearchParams();
  if (type !== 'SAVED') sp.set('type', type);
  if (topic !== 'ALL') sp.set('topic', topic);
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}

export function Document({ children }: { children: Child }) {
  const { css, js } = assets();
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="theme-color" content="#0a0a0a" />
          <title>not-reels</title>
          <meta name="description" content="Personal RSS feed compiler" />
          <link rel="manifest" href="/manifest.json" />
          <meta name="mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <meta name="apple-mobile-web-app-title" content="not-reels" />
          <link rel="apple-touch-icon" href="/icons/galaxy.png" />
          <link rel="icon" href="/favicon.ico" sizes="any" />
          <link rel="preload" href="/fonts/rambla-400.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="preload" href="/fonts/rambla-700.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <style>{raw(css)}</style>
          <script src={js} defer></script>
        </head>
        <body class="bg-background text-foreground min-h-screen font-rambla antialiased">
          <div id="app">{children}</div>
        </body>
      </html>
    </>
  );
}

export function NavBar({ path, type, topic, topics }: { path: string; type: FilterType; topic: string; topics: TopicRecord[] }) {
  const onFeedRoute = path === '/' || path === '/saved';
  return (
    <header
      data-testid="nav-bar"
      class="nav sticky top-0 z-40 border-b border-border"
      style="padding-top:env(safe-area-inset-top)"
    >
      <div class="mx-auto max-w-2xl px-3 pt-2.5 pb-2 flex items-center justify-between gap-2">
        <a href="/" data-nav class="font-bold text-2xl tracking-tight">
          Not Reels
        </a>
        <a
          href="/manage"
          data-nav
          data-testid="nav-manage-link"
          class={`text-sm px-1 py-1 ${path === '/manage' ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          Manage
        </a>
      </div>
      {onFeedRoute && (
        <div class="mx-auto max-w-2xl">
          <div class="pill-row flex gap-2 overflow-x-auto scrollbar-hide px-3 pb-2" data-testid="type-filter-row">
            {TYPE_OPTIONS.map((opt) => (
              <a
                href={viewHref(opt.value, topic)}
                data-nav
                data-testid={`type-pill-${opt.value}`}
                aria-current={type === opt.value ? 'true' : undefined}
                class="pill type-pill shrink-0 inline-flex items-center justify-center h-9 min-w-[64px] px-3.5 rounded-full text-sm border"
              >
                {opt.label}
              </a>
            ))}
          </div>
          <div class="pill-row flex gap-2 overflow-x-auto scrollbar-hide px-3 pb-2.5" data-testid="topic-filter-row">
            {[{ slug: 'ALL', label: 'All' }, ...topics].map((t) => (
              <a
                href={viewHref(type, t.slug)}
                data-nav
                data-testid={`topic-pill-${t.slug}`}
                aria-current={topic === t.slug ? 'true' : undefined}
                class="pill topic-pill shrink-0 inline-flex items-center h-8 px-3 rounded-full text-xs border"
              >
                {t.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

export function Main({ children }: { children: Child }) {
  return <main class="mx-auto max-w-2xl px-3 pb-10">{children}</main>;
}

/** Cards plus the infinite-scroll sentinel. Also returned on its own by /_f/items. */
export function FeedItemsChunk({
  items,
  nextCursor,
  query,
  now,
}: {
  items: FeedItemDTO[];
  nextCursor: string | null;
  query: string;
  now: Date;
}) {
  return (
    <>
      {items.map((item) => (
        <FeedCard item={item} now={now} />
      ))}
      <div data-testid="sentinel" class="sentinel h-8" data-cursor={nextCursor ?? undefined} data-q={query}></div>
    </>
  );
}

export function FeedPage({
  type,
  topic,
  sort,
  data,
}: {
  type: FilterType;
  topic: string;
  sort: SortOrder;
  data: { items: FeedItemDTO[]; nextCursor: string | null } | { error: string };
}) {
  const now = new Date();
  const sp = new URLSearchParams({ type, sort });
  if (topic !== 'ALL') sp.set('topic', topic);
  return (
    <div class="flex flex-col gap-3 pt-3" data-testid="feed-list" data-view="feed" data-current-sort={sort}>
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-act="refresh"
          data-testid="refresh-button"
          class="shrink-0 h-9 px-3.5 rounded-full text-sm border border-border bg-transparent active:bg-accent disabled:opacity-50"
        >
          Refresh feeds
        </button>
        {type !== 'SAVED' && <div class="seg flex shrink-0 rounded-full border border-border overflow-hidden text-sm" role="tablist">
          {(['recommended', 'new', 'random'] as const).map((s) => (
            <button
              type="button"
              role="tab"
              data-sort={s}
              data-testid={`sort-${s}`}
              aria-selected={sort === s ? 'true' : 'false'}
              class="h-9 px-3.5"
            >
              {SORT_LABELS[s]}
            </button>
          ))}
        </div>}
        <span class="text-xs text-muted-foreground ml-auto text-right leading-tight" data-testid="refresh-status" hidden></span>
      </div>
      <div class="feed-items flex flex-col gap-3">
        {'error' in data ? (
          <EmptyState message="Failed to load feed." />
        ) : data.items.length === 0 ? (
          <EmptyState message="No items match these filters yet." />
        ) : (
          <FeedItemsChunk items={data.items} nextCursor={data.nextCursor} query={sp.toString()} now={now} />
        )}
      </div>
    </div>
  );
}

export function SavedPage({ links, topics }: { links: SavedLinkDTO[]; topics: TopicRecord[] }) {
  const now = new Date();
  return (
    <div class="pt-3 flex flex-col gap-3" data-view="saved">
      <button
        type="button"
        data-open="add-saved-link"
        data-testid="add-saved-link-btn"
        class="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm self-start"
      >
        + Save link
      </button>
      {links.length === 0 ? <EmptyState message="No saved links yet." /> : links.map((l) => <SavedLinkCard link={l} now={now} />)}
      <Modal name="add-saved-link" testId="add-saved-link-modal" title="Save a link">
        <input type="url" name="url" required placeholder="https://..." class={inputClass} />
        <input type="text" name="title" required placeholder="Title" class={inputClass} />
        <select name="topic" disabled={topics.length === 0} class={inputClass}>
          {topics.length === 0 && <option value="">No topics — add one in Manage</option>}
          {topics.map((t) => (
            <option value={t.slug}>{t.label}</option>
          ))}
        </select>
        <textarea
          name="notes"
          placeholder="Notes (optional)"
          rows={2}
          class="px-3 py-2 rounded-md bg-background border border-border text-base sm:text-sm"
        ></textarea>
      </Modal>
    </div>
  );
}

export function ManagePage({ topics, feeds }: { topics: TopicRecord[]; feeds: FeedDTO[] }) {
  return (
    <div class="pt-3 flex flex-col gap-3" data-view="manage">
      <section data-testid="topics-manager" class="rounded-lg border border-border bg-card p-3 flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold">Topics</h2>
          <span class="text-xs text-muted-foreground">{topics.length}</span>
        </div>
        <form data-form="add-topic" class="flex gap-2">
          <input
            type="text"
            name="label"
            placeholder="New topic (e.g. Gaming)"
            data-testid="topic-input"
            class="flex-1 min-w-0 h-9 px-3 rounded-md bg-background border border-border text-base sm:text-sm"
          />
          <button
            type="submit"
            data-testid="add-topic-btn"
            class="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
          >
            Add
          </button>
        </form>
        <p class="form-error text-xs text-destructive" hidden></p>
        {topics.length === 0 ? (
          <p class="text-xs text-muted-foreground">No topics yet.</p>
        ) : (
          <ul class="flex flex-wrap gap-2">
            {topics.map((t) => (
              <li
                data-testid="topic-chip"
                class="inline-flex items-center gap-1 h-8 pl-3 pr-1 rounded-full border border-border bg-background text-xs"
              >
                <span>{t.label}</span>
                <button
                  type="button"
                  data-act="delete-topic"
                  data-slug={t.slug}
                  data-label={t.label}
                  aria-label={`Delete topic ${t.label}`}
                  data-testid={`delete-topic-${t.slug}`}
                  class="w-6 h-6 rounded-full text-destructive active:bg-destructive/10 text-base leading-none"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <button
        type="button"
        data-open="add-feed"
        data-testid="add-feed-btn"
        class="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm self-start"
      >
        + Add feed
      </button>
      {feeds.length === 0 ? (
        <EmptyState message="No feeds yet. Add your first one above." />
      ) : (
        feeds.map((feed) => (
          <div
            data-testid="feed-row"
            data-id={feed.id}
            data-name={feed.name}
            data-topics={feed.topics.join(',')}
            class="rounded-lg border border-border bg-card p-3 flex flex-col gap-2"
          >
            <div class="flex items-center gap-2 flex-wrap">
              <TypeBadge type={feed.type} />
              {feed.topics.map((t) => (
                <TopicBadge topic={t} />
              ))}
              {!feed.isActive && <span class="text-[10px] font-bold uppercase text-destructive">paused</span>}
            </div>
            <div class="text-sm font-bold">{feed.name}</div>
            <div class="text-xs text-muted-foreground break-all">{feed.url}</div>
            <div class="flex gap-2 mt-1">
              <button type="button" data-act="refresh-feed" disabled={!feed.isActive} class="row-btn">
                Refresh
              </button>
              <button
                type="button"
                data-act="pause-feed"
                data-active={feed.isActive ? '1' : '0'}
                data-testid="feed-pause-btn"
                class="row-btn"
              >
                {feed.isActive ? 'Pause' : 'Resume'}
              </button>
              <button type="button" data-act="edit-feed" data-testid="feed-edit-btn" class="row-btn">
                Edit
              </button>
              <button type="button" data-act="delete-feed" data-testid="feed-delete-btn" class="row-btn text-destructive">
                Delete
              </button>
            </div>
          </div>
        ))
      )}
      <Modal name="add-feed" testId="add-feed-modal" title="Add a feed">
        <input type="text" name="name" required placeholder="Feed name" class={inputClass} />
        <input
          type="text"
          name="url"
          required
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          placeholder="https://example.com/rss.xml or local/rym_music_recs"
          class={inputClass}
        />
        <select name="type" class={inputClass}>
          {FEED_TYPES.map((t) => (
            <option value={t}>{FEED_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <TopicCheckboxList topics={topics} />
      </Modal>
      <Modal name="edit-feed" testId="edit-feed-modal" title="Edit topics">
        <input type="hidden" name="id" />
        <p class="feed-name text-xs text-muted-foreground break-all"></p>
        <TopicCheckboxList topics={topics} />
      </Modal>
    </div>
  );
}
