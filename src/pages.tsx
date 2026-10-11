import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { parseFeedItemsQuery } from './api/feed-items';
import { listFeedItems, listFeeds, listSavedLinks } from './lib/queries';
import { listTopics } from './lib/topics';
import type { FilterType, SortOrder } from './lib/types';
import { Document, FeedItemsChunk, FeedPage, Main, ManagePage, NavBar, SavedPage } from './views/pages';

export const pagesRouter = new Hono();

/**
 * Full document on a normal load; only the #app contents (nav + main) when the client
 * swaps views itself (header X-Partial: 1).
 */
function render(c: Context, path: string, type: FilterType, topic: string, body: Child): Response | Promise<Response> {
  const app = (
    <>
      <NavBar path={path} type={type} topic={topic} topics={listTopics()} />
      <Main>{body}</Main>
    </>
  );
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'X-Partial');
  return c.html(c.req.header('X-Partial') ? app : <Document>{app}</Document>);
}

pagesRouter.get('/', (c) => {
  const type = (c.req.query('type') || 'FORUM') as FilterType;
  const topic = c.req.query('topic') || 'ALL';
  const sortParam = c.req.query('sort') as SortOrder | undefined;
  const sort: SortOrder = sortParam === 'new' || sortParam === 'random' ? sortParam : 'recommended';
  const q = parseFeedItemsQuery({ type, topic, sort });
  const data = 'error' in q ? q : listFeedItems(q);
  return render(c, '/', type, topic, <FeedPage type={type} topic={topic} sort={sort} data={data} />);
});

pagesRouter.get('/saved', (c) => {
  const topic = c.req.query('topic') || 'ALL';
  return render(c, '/saved', 'SAVED', topic, <SavedPage links={listSavedLinks(topic)} topics={listTopics()} />);
});

pagesRouter.get('/manage', (c) => {
  return render(c, '/manage', 'FORUM', 'ALL', <ManagePage topics={listTopics()} feeds={listFeeds()} />);
});

/** Next page of cards for infinite scroll (New sort). */
pagesRouter.get('/_f/items', (c) => {
  const params = c.req.query();
  const q = parseFeedItemsQuery(params);
  if ('error' in q) return c.text(q.error, 400);
  const data = listFeedItems(q);
  const sp = new URLSearchParams(params);
  sp.delete('cursor');
  c.header('Cache-Control', 'no-store');
  return c.html(<FeedItemsChunk items={data.items} nextCursor={data.nextCursor} query={sp.toString()} now={new Date()} />);
});
