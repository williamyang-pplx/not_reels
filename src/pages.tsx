import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { parseFeedItemsQuery } from './api/feed-items';
import { assets } from './assets';
import { getItemSummary, listFeedItems, listFeeds, listSavedLinks } from './lib/queries';
import { listTopics } from './lib/topics';
import type { SortOrder } from './lib/types';
import { decodeEntities, reflowText } from './lib/utils';
import { Document, FeedItemsChunk, FeedPage, Main, ManagePage, NavBar, SavedPage } from './views/pages';

export const pagesRouter = new Hono();

/**
 * Full document on a normal load; only the #app contents (nav + main) when the client
 * swaps views itself (header X-Partial: 1).
 */
function render(c: Context, path: string, topic: string, body: Child): Response | Promise<Response> {
  const app = (
    <>
      <NavBar path={path} topic={topic} topics={listTopics()} />
      <Main>{body}</Main>
    </>
  );
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'X-Partial');
  c.header('X-Build', assets().build);
  return c.html(c.req.header('X-Partial') ? app : <Document>{app}</Document>);
}

pagesRouter.get('/', (c) => {
  const topic = c.req.query('topic') || 'ALL';
  const sortParam = c.req.query('sort') as SortOrder | undefined;
  const sort: SortOrder = sortParam === 'new' || sortParam === 'random' ? sortParam : 'recommended';
  const q = parseFeedItemsQuery({ topic, sort });
  const data = 'error' in q ? q : listFeedItems(q);
  return render(c, '/', topic, <FeedPage topic={topic} sort={sort} data={data} />);
});

pagesRouter.get('/saved', (c) => {
  const topic = c.req.query('topic') || 'ALL';
  return render(c, '/saved', topic, <SavedPage links={listSavedLinks(topic)} topics={listTopics()} />);
});

pagesRouter.get('/manage', (c) => {
  return render(c, '/manage', 'ALL', <ManagePage topics={listTopics()} feeds={listFeeds()} />);
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
  c.header('X-Build', assets().build);
  return c.html(<FeedItemsChunk items={data.items} nextCursor={data.nextCursor} query={sp.toString()} now={new Date()} />);
});

/** A card's whole summary, as plain text, for its More button (cards only carry an excerpt). */
pagesRouter.get('/_f/summary/:id', (c) => {
  const summary = getItemSummary(c.req.param('id'));
  if (summary === undefined) return c.text('Not found', 404);
  c.header('Cache-Control', 'no-store');
  return c.text(reflowText(decodeEntities(summary ?? '')));
});
