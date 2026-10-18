import type { Child } from 'hono/jsx';
import { RYM_FEED_URL } from '../lib/constants';
import { detectEmbedKind, extractRedditPost, extractYouTubeId } from '../lib/embed';
import type { FeedItemDTO, SavedLinkDTO } from '../lib/queries';
import type { TopicRecord } from '../lib/types';
import { decodeEntities, formatRelativeTime, reflowText, topicColor } from '../lib/utils';

export function EmptyState({ message }: { message: string }) {
  return (
    <div data-testid="empty-state" class="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
      <p class="text-sm">{message}</p>
    </div>
  );
}

export function TopicBadge({ topic }: { topic: string }) {
  return (
    <span class="tb" style={`background:${topicColor(topic)}`}>
      {topic}
    </span>
  );
}

/** Shared bottom-sheet / centered modal shell (spec §8.8). Hidden until the client opens it. */
export function Modal({ name, testId, title, children }: { name: string; testId: string; title: string; children: Child }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      data-modal={name}
      hidden
      class="modal fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
    >
      <form data-form={name} class="sheet w-full max-w-md rounded-lg bg-card border border-border p-4 flex flex-col gap-3">
        <h2 class="text-base font-bold">{title}</h2>
        {children}
        <p class="form-error text-xs text-destructive" hidden></p>
        <div class="flex gap-2 justify-end">
          <button type="button" data-close class="h-10 px-4 rounded-md border border-border text-sm">
            Cancel
          </button>
          <button type="submit" class="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
            {name === 'add-feed' ? 'Add feed' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputClass = 'h-10 px-3 rounded-md bg-background border border-border text-base sm:text-sm w-full';
export { inputClass };

export function TopicCheckboxList({ topics, selected = [] }: { topics: TopicRecord[]; selected?: string[] }) {
  if (topics.length === 0) {
    return (
      <div class="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        No topics — add one in Manage
      </div>
    );
  }
  return (
    <div class="topic-list rounded-md border border-border bg-background max-h-40 overflow-y-auto">
      {topics.map((t) => (
        <label class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer active:bg-accent">
          <input
            type="checkbox"
            name="topics"
            value={t.slug}
            checked={selected.includes(t.slug)}
            data-testid={`topic-checkbox-${t.slug}`}
            class="h-4 w-4 accent-primary"
          />
          <span>{t.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---------- feed card ----------

/** Only http(s) links become clickable; a feed could otherwise ship `javascript:` URLs. */
function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * Summaries can be whole articles, so a card carries only an excerpt, about a screenful, for the first paint. The
 * client swaps in the whole summary (/_f/summary/:id) for any card marked data-more.
 */
const SUMMARY_WORDS = 80;

function Summary({ id, summary }: { id: string; summary: string }) {
  const words = summary.split(/\s+/);
  const cut = words.length > SUMMARY_WORDS;
  return (
    <p class="sum" data-more={cut ? id : undefined}>
      {cut ? `${words.slice(0, SUMMARY_WORDS).join(' ')}…` : reflowText(summary)}
    </p>
  );
}

function parseRymMusicRec(item: FeedItemDTO) {
  const prefix = item.author ? `${item.author} - ` : '';
  const albumTitle = item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title;
  const parts = (item.summary ?? '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const ratingIndex = parts.findIndex((p) => /^RYM\b/i.test(p));
  if (ratingIndex === 0) {
    return { albumTitle, artistName: item.author, rating: parts[0] ?? null, releaseDate: parts[1] ?? null, genres: parts[2] ?? null };
  }
  return {
    albumTitle,
    artistName: item.author,
    genres: parts[0] ?? null,
    releaseDate: parts[1] ?? null,
    rating: ratingIndex >= 0 ? parts[ratingIndex] : (parts[2] ?? null),
  };
}

function youtubeMusicSearchUrl(albumTitle: string): string {
  return `https://music.youtube.com/search?q=${albumTitle.trim().split(/\s+/).map(encodeURIComponent).join('+')}`;
}

function YouTubeFacade({ id, title }: { id: string; title: string }) {
  return (
    <div class="mt-3 aspect-video w-full overflow-hidden rounded-md bg-muted relative">
      <button
        type="button"
        data-act="yt"
        data-id={id}
        aria-label={`Play: ${title}`}
        class="yt absolute inset-0 w-full h-full"
      >
        <img
          src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
          alt=""
          loading="lazy"
          decoding="async"
          class="absolute inset-0 w-full h-full object-cover"
        />
        <span class="yt-play" aria-hidden="true"></span>
      </button>
    </div>
  );
}

function RedditEmbed({ subreddit, postId, slug, title }: { subreddit: string; postId: string; slug: string; title: string }) {
  return (
    <div class="mt-3 w-full overflow-hidden rounded-md border border-border bg-muted">
      {/* data-src: the client sets src once the card is ~300px from the viewport (see client/app.ts). */}
      <iframe
        data-src={`https://www.redditmedia.com/r/${subreddit}/comments/${postId}/${slug}/?ref_source=embed&ref=share&embed=true`}
        title={title || `Reddit thread in r/${subreddit}`}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        class="block h-[40dvh] w-full"
      ></iframe>
    </div>
  );
}

export function FeedCard({ item: raw, now }: { item: FeedItemDTO; now: Date }) {
  const item = { ...raw, title: decodeEntities(raw.title), summary: raw.summary && decodeEntities(raw.summary) };
  const topic = item.feedTopics[0];
  const isRym = item.feedUrl === RYM_FEED_URL || item.guid.startsWith('rym-album-');
  const kind = isRym ? null : detectEmbedKind(item.link);
  const youTubeId = kind === 'youtube' ? extractYouTubeId(item.link) : null;
  const reddit = kind === 'reddit' ? extractRedditPost(item.link) : null;
  const rym = isRym ? parseRymMusicRec(item) : null;
  const shownTitle = rym ? rym.albumTitle : item.title;

  // Markup is kept terse (short classes from styles.css, no duplicated data) because a page
  // carries up to 100 of these. The client reads the link from the first <a href> and the
  // title from the <h3> unless data-title says otherwise.
  return (
    <article
      data-testid="feed-card"
      data-topic={topic}
      data-title={raw.title !== shownTitle ? raw.title : undefined}
      data-href={safeHref(item.link) ? undefined : item.link}
      class="card fc"
      style={`border-color:${topicColor(topic)}`}
    >
      <a href={safeHref(item.link)} target="_blank" rel="noopener noreferrer" class="cl">
        <div class="meta">
          <b>{item.feedName || (isRym ? 'Rate Your Music' : 'Unknown')}</b>
          <time datetime={item.publishedAt}>{formatRelativeTime(item.publishedAt, now)}</time>
        </div>
        <h3>{shownTitle}</h3>
        {rym ? (
          <>
            {rym.artistName && <p class="artist">{rym.artistName}</p>}
            <div class="rym">
              {rym.genres && <p>{rym.genres}</p>}
              {rym.releaseDate && <p class="m">{rym.releaseDate}</p>}
              {rym.rating && <p class="m">{rym.rating}</p>}
            </div>
          </>
        ) : (
          item.summary && <Summary id={item.id} summary={item.summary} />
        )}
      </a>
      {youTubeId && <YouTubeFacade id={youTubeId} title={item.title} />}
      {reddit && <RedditEmbed {...reddit} title={item.title} />}
      <div class="badges">
        {topic && <TopicBadge topic={topic} />}
      </div>
      <div class="acts">
        {topic && (
          <button data-act="save" data-testid="save-feed-item-btn">
            Save
          </button>
        )}
        <button data-act="hide" data-testid="hide-feed-item-btn" class="m">
          Hide
        </button>
        {rym ? (
          <a
            href={youtubeMusicSearchUrl(rym.albumTitle)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="youtube-music-feed-item-link"
            class="ytm"
          >
            <img src="/youtube_music_icon.png" alt="" aria-hidden="true" width="16" height="16" />
            YouTube Music
          </a>
        ) : (
          <>
            <button data-act="archive" data-testid="archive-feed-item-btn">
              archive.*
            </button>
            <button data-act="press">press released</button>
          </>
        )}
        <span class="err" hidden></span>
      </div>
    </article>
  );
}

export function SavedLinkCard({ link, now }: { link: SavedLinkDTO; now: Date }) {
  return (
    <article
      data-testid="saved-link-card"
      data-id={link.id}
      data-href={safeHref(link.url) ? undefined : link.url}
      class="card sc"
    >
      <div class="meta">
        <TopicBadge topic={link.topic} />
        <time datetime={link.savedAt}>{formatRelativeTime(link.savedAt, now)}</time>
      </div>
      <a href={safeHref(link.url)} target="_blank" rel="noopener noreferrer" class="cl">
        <h3>{decodeEntities(link.title)}</h3>
      </a>
      {link.notes && <p class="notes">{link.notes}</p>}
      <div class="acts">
        <button data-act="delete-saved" data-testid="saved-link-delete" class="d">
          Delete
        </button>
        <button data-act="archive">archive.*</button>
        <button data-act="press">press released</button>
      </div>
    </article>
  );
}
