// The only browser JS. Pages are server-rendered; this file swaps views in place (with a
// small cache standing in for React Query), runs card actions, infinite scroll and the forms.

type Sort = 'recommended' | 'new' | 'random';
type Kind = 'feed' | 'saved' | 'manage';
interface Entry {
  html?: string;
  at: number;
  p?: Promise<string>;
}

const FRESH_MS = 30_000;
const app = document.getElementById('app')!;
const cache = new Map<string, Entry>();
let sort: Sort = (app.querySelector<HTMLElement>('[data-current-sort]')?.dataset.currentSort as Sort) || 'recommended';
let refreshStatus: string | null = null;
let navToken = 0;

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

// ---------- progress bar ----------

const bar = document.createElement('div');
bar.id = 'bar';
document.body.appendChild(bar);
let barTimer = 0;
function loading(on: boolean) {
  clearTimeout(barTimer);
  if (on) {
    // Only show for loads slower than ~80 ms, so cached/instant swaps never flash.
    barTimer = window.setTimeout(() => {
      bar.className = '';
      void bar.offsetWidth;
      bar.className = 'on';
    }, 80);
  } else if (bar.className === 'on') {
    bar.className = 'done';
  }
}

// ---------- view cache ----------

function kindOf(path: string): Kind {
  return path === '/saved' ? 'saved' : path === '/manage' ? 'manage' : 'feed';
}

/** Cache key = the URL the server renders; "/" carries the client-only sort. */
function keyFor(url: URL): string {
  if (url.pathname !== '/') return url.pathname + url.search;
  const sp = new URLSearchParams(url.search);
  sp.set('sort', sort);
  return `/?${sp}`;
}

function load(key: string, force = false): Promise<string> {
  const hit = cache.get(key);
  if (hit?.p) return hit.p;
  if (!force && hit?.html !== undefined && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.html);
  const entry: Entry = { html: hit?.html, at: hit?.at ?? 0 };
  entry.p = fetch(key, { headers: { 'X-Partial': '1' } })
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then(
      (html) => {
        entry.html = html;
        entry.at = Date.now();
        entry.p = undefined;
        return html;
      },
      (err) => {
        entry.p = undefined;
        if (entry.html === undefined) cache.delete(key);
        throw err;
      },
    );
  cache.set(key, entry);
  return entry.p;
}

/** Mirror of React Query invalidation: drop cached views of these kinds. */
function invalidate(...kinds: Kind[]) {
  for (const key of cache.keys()) {
    if (kinds.includes(kindOf(key.split('?')[0]))) cache.delete(key);
  }
}

function prefetch(href: string) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  const saved = sort;
  if (url.pathname === '/' && location.pathname !== '/') sort = 'recommended';
  load(keyFor(url)).catch(() => {});
  sort = saved;
}

// ---------- swapping ----------

function swap(html: string, scroll: number | null) {
  const rows = $$('.pill-row').map((r) => r.scrollLeft);
  app.innerHTML = html;
  $$('.pill-row').forEach((r, i) => (r.scrollLeft = rows[i] ?? 0));
  if (scroll !== null) window.scrollTo(0, scroll);
  hydrate();
}

/** Instant visual feedback while a view loads: move the pill highlight right away. */
function markPills(url: URL) {
  const type = url.pathname === '/saved' ? 'SAVED' : url.searchParams.get('type') || 'FORUM';
  const topic = url.searchParams.get('topic') || 'ALL';
  for (const a of $$('[data-testid^="type-pill-"]')) a.toggleAttribute('aria-current', a.dataset.testid === `type-pill-${type}`);
  for (const a of $$('[data-testid^="topic-pill-"]')) a.toggleAttribute('aria-current', a.dataset.testid === `topic-pill-${topic}`);
}

async function navigate(href: string, opts: { push?: boolean; scroll?: number | null; force?: boolean } = {}) {
  const url = new URL(href, location.href);
  const fromPath = location.pathname;
  if (url.pathname === '/' && fromPath !== '/') sort = 'recommended';
  if (url.pathname !== '/') refreshStatus = null;
  const key = keyFor(url);
  const token = ++navToken;
  const scroll = opts.scroll === undefined ? 0 : opts.scroll;

  if (opts.push !== false && url.pathname + url.search !== location.pathname + location.search) {
    history.replaceState({ ...history.state, y: window.scrollY }, '');
    history.pushState({ y: 0 }, '', url.pathname + url.search);
  }

  const hit = cache.get(key);
  const fresh = hit?.html !== undefined && Date.now() - hit.at < FRESH_MS;
  if (hit?.html !== undefined && !opts.force) {
    swap(hit.html, scroll);
    if (fresh) return;
    // Stale: revalidate, and only re-render if the user hasn't started reading yet.
    load(key, true)
      .then((html) => {
        if (token === navToken && html !== hit.html && window.scrollY < 40 && sort !== 'random') swap(html, null);
      })
      .catch(() => {});
    return;
  }

  markPills(url);
  loading(true);
  try {
    const html = await load(key, opts.force);
    if (token === navToken) swap(html, scroll);
  } catch {
    if (token !== navToken) return;
    const list = $('.feed-items');
    if (list) list.innerHTML = emptyState('Failed to load feed.');
    else location.href = url.pathname + url.search;
  } finally {
    if (token === navToken) loading(false);
  }
}

/** Re-render the current view from the server, keeping the scroll position. */
function reload() {
  return navigate(location.href, { push: false, scroll: null, force: true });
}

function emptyState(message: string) {
  return `<div data-testid="empty-state" class="flex flex-col items-center justify-center py-16 text-center text-muted-foreground"><p class="text-sm">${message}</p></div>`;
}

// ---------- after every render ----------

let observer: IntersectionObserver | null = null;

function hydrate() {
  const status = $('[data-testid="refresh-status"]');
  if (status && refreshStatus) {
    status.textContent = refreshStatus;
    status.hidden = false;
  }
  observer?.disconnect();
  const sentinel = $<HTMLElement>('.sentinel[data-cursor]');
  if (!sentinel) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadMore(sentinel);
    },
    { rootMargin: '800px 0px' },
  );
  observer.observe(sentinel);
}

async function loadMore(sentinel: HTMLElement) {
  observer?.disconnect();
  const more = document.createElement('div');
  more.className = 'text-center text-xs text-muted-foreground py-2';
  more.textContent = 'Loading more…';
  sentinel.after(more);
  try {
    const res = await fetch(`/_f/items?${sentinel.dataset.q}&cursor=${encodeURIComponent(sentinel.dataset.cursor!)}`);
    if (!res.ok) throw new Error();
    const html = await res.text();
    more.remove();
    sentinel.insertAdjacentHTML('afterend', html);
    sentinel.remove();
  } catch {
    more.remove();
    return; // leave the sentinel unobserved; the next view render retries
  }
  hydrate();
}

// ---------- API ----------

async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(json?.error?.message ?? 'Failed');
  return json?.data as T;
}

const errMsg = (err: unknown, fallback: string) => (err instanceof Error && err.message !== 'Failed' ? err.message : fallback);

// ---------- card actions ----------

function cleanUrl(input: string): string {
  const u = new URL(input);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** The item URL exactly as stored: the raw href of the card's first link. */
function linkOf(card: HTMLElement): string {
  return $('a', card)!.getAttribute('href') ?? '';
}

function openTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Fade a card out and swap it for an invisible marker, so it can be put back if the request fails. */
function detachCard(card: HTMLElement): Promise<Comment> {
  return new Promise((resolve) => {
    card.classList.add('leaving');
    card.addEventListener(
      'animationend',
      () => {
        const marker = document.createComment('card');
        card.replaceWith(marker);
        card.classList.remove('leaving');
        resolve(marker);
      },
      { once: true },
    );
  });
}

/** After cards are gone for good: re-render if the list is now empty, else re-cache this view. */
function settleList(markers: Comment[]) {
  markers.forEach((m) => m.remove());
  if (!$('[data-testid="feed-card"],[data-testid="saved-link-card"]', app)) return void reload();
  cache.set(keyFor(new URL(location.href)), { html: app.innerHTML, at: Date.now() });
}

/**
 * Save / Hide are optimistic: the card starts leaving on tap and is restored, with the error
 * shown inline, only if the server rejects the request.
 */
async function cardMutation(btn: HTMLButtonElement, card: HTMLElement, kind: 'save' | 'hide') {
  const labels = kind === 'save' ? ['Saved!', 'Failed to save'] : ['Hidden', 'Failed to hide'];
  const err = $('.err', card)!;
  const prev = btn.textContent;
  const link = linkOf(card);
  btn.disabled = true;
  btn.textContent = labels[0];
  err.hidden = true;
  // Every copy of this URL drops out of the stream.
  const cards = $$<HTMLElement>('[data-testid="feed-card"]').filter((c) => linkOf(c) === link);
  const detached = Promise.all(cards.map(detachCard));
  try {
    if (kind === 'save') {
      const title = card.dataset.title ?? $('h3', card)!.textContent;
      await api('POST', '/api/saved-links', { url: link, title, topic: card.dataset.topic });
      invalidate('feed', 'saved');
    } else {
      await api('POST', '/api/hidden-links', { url: link });
      invalidate('feed');
    }
    settleList(await detached);
  } catch (e) {
    const markers = await detached;
    markers.forEach((m, i) => m.replaceWith(cards[i]));
    btn.disabled = false;
    btn.textContent = prev;
    err.textContent = errMsg(e, labels[1]);
    err.hidden = false;
  }
}

function playYouTube(btn: HTMLElement) {
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.id}?autoplay=1&rel=0&playsinline=1`;
  iframe.title = btn.getAttribute('aria-label') ?? 'YouTube video';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  iframe.className = 'absolute inset-0 w-full h-full border-0';
  btn.replaceWith(iframe);
}

async function refreshAll(btn: HTMLButtonElement) {
  const status = $('[data-testid="refresh-status"]')!;
  refreshStatus = null;
  status.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const r = await api<{ refreshed: number; newItems: number; failed: number }>('POST', '/api/feed-items/refresh', {});
    refreshStatus =
      r.failed > 0 ? `Refreshed ${r.refreshed}, ${r.newItems} new, ${r.failed} failed` : `Refreshed ${r.refreshed} · ${r.newItems} new`;
    invalidate('feed');
    await reload();
  } catch {
    refreshStatus = 'Refresh failed';
    hydrate();
  } finally {
    const b = $<HTMLButtonElement>('[data-testid="refresh-button"]');
    if (b) {
      b.disabled = false;
      b.textContent = 'Refresh feeds';
    }
  }
}

// ---------- manage page ----------

function slugify(label: string) {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function showError(el: Element | null, message: string | null) {
  if (!(el instanceof HTMLElement)) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

async function rowAction(act: string, btn: HTMLButtonElement) {
  const row = btn.closest<HTMLElement>('[data-testid="feed-row"]')!;
  const id = row.dataset.id!;
  if (act === 'refresh-feed') {
    // Same as the original: fire and forget, no invalidation, no UI.
    api('POST', '/api/feed-items/refresh', { feedId: id }).catch(() => {});
    return;
  }
  if (act === 'edit-feed') {
    const modal = openModal('edit-feed');
    const topics = (row.dataset.topics ?? '').split(',').filter(Boolean);
    $<HTMLInputElement>('input[name="id"]', modal)!.value = id;
    $('.feed-name', modal)!.textContent = row.dataset.name ?? '';
    for (const cb of $$<HTMLInputElement>('input[name="topics"]', modal)) cb.checked = topics.includes(cb.value);
    syncSubmit(modal);
    return;
  }
  btn.disabled = true;
  try {
    if (act === 'pause-feed') await api('PATCH', `/api/feeds/${id}`, { isActive: btn.dataset.active !== '1' });
    if (act === 'delete-feed') await api('DELETE', `/api/feeds/${id}`);
    invalidate('manage', 'feed');
    await reload();
  } catch {
    btn.disabled = false;
  }
}

async function deleteTopic(btn: HTMLButtonElement) {
  const { slug, label } = btn.dataset;
  if (!window.confirm(`Delete topic "${label}"? This will also delete all feeds and saved links under this topic.`)) return;
  const err = $('[data-testid="topics-manager"] .form-error');
  try {
    await api('DELETE', `/api/topics/${encodeURIComponent(slug!)}`);
    cache.clear();
    await reload();
  } catch (e) {
    showError(err, errMsg(e, 'Failed'));
  }
}

// ---------- modals & forms ----------

function openModal(name: string): HTMLElement {
  const modal = $<HTMLElement>(`[data-modal="${name}"]`)!;
  showError($('.form-error', modal), null);
  modal.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  return modal;
}

function closeModal(modal: HTMLElement) {
  modal.hidden = true;
  document.documentElement.style.overflow = '';
}

/** Add/Edit feed: submit stays disabled until a topic is picked (spec §8.8). */
function syncSubmit(modal: HTMLElement) {
  const submit = $<HTMLButtonElement>('button[type="submit"]', modal)!;
  submit.disabled =
    modal.dataset.modal === 'add-saved-link'
      ? !!$('select[name="topic"]:disabled', modal)
      : !$('input[name="topics"]:checked', modal);
}

const PENDING: Record<string, [string, string]> = {
  'add-feed': ['Adding…', 'Add feed'],
  'edit-feed': ['Saving…', 'Save'],
  'add-saved-link': ['Saving…', 'Save'],
};

async function submitForm(form: HTMLFormElement) {
  const name = form.dataset.form!;
  const fd = new FormData(form);
  const str = (k: string) => String(fd.get(k) ?? '');

  if (name === 'add-topic') {
    const err = form.parentElement!.querySelector('.form-error');
    const label = str('label').trim();
    if (!label) return;
    const slug = slugify(label);
    if (!slug) return showError(err, 'Label must contain letters or digits');
    const btn = $<HTMLButtonElement>('button', form)!;
    btn.disabled = true;
    try {
      await api('POST', '/api/topics', { slug, label });
      cache.clear(); // topics show up in every view's nav
      await reload();
    } catch (e) {
      showError(err, errMsg(e, 'Failed'));
      btn.disabled = false;
    }
    return;
  }

  const modal = form.closest<HTMLElement>('[data-modal]')!;
  const err = $('.form-error', modal);
  const submit = $<HTMLButtonElement>('button[type="submit"]', form)!;
  const topics = fd.getAll('topics').map(String);
  if ((name === 'add-feed' || name === 'edit-feed') && topics.length === 0) return showError(err, 'Pick at least one topic');
  if (name === 'add-saved-link' && !str('topic')) return showError(err, 'Create a topic first');

  showError(err, null);
  submit.disabled = true;
  submit.textContent = PENDING[name][0];
  try {
    if (name === 'add-feed') {
      await api('POST', '/api/feeds', { name: str('name'), url: str('url'), type: str('type'), topics });
      invalidate('manage', 'feed');
    } else if (name === 'edit-feed') {
      await api('PATCH', `/api/feeds/${str('id')}`, { topics });
      invalidate('manage', 'feed');
    } else {
      await api('POST', '/api/saved-links', {
        url: str('url'),
        title: str('title'),
        topic: str('topic'),
        notes: str('notes') || undefined,
      });
      invalidate('saved');
    }
    form.reset();
    closeModal(modal);
    await reload();
  } catch (e) {
    showError(err, errMsg(e, name === 'add-saved-link' ? 'Failed to save' : name === 'add-feed' ? 'Failed to add feed' : 'Failed to update feed'));
  } finally {
    submit.textContent = PENDING[name][1];
    syncSubmit(modal);
  }
}

// ---------- event wiring ----------

function navLink(e: Event): HTMLAnchorElement | null {
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-nav]');
  return a && a.origin === location.origin ? a : null;
}

document.addEventListener('pointerdown', (e) => {
  const a = navLink(e);
  if (a) prefetch(a.href);
});

document.addEventListener('click', (e) => {
  const me = e as MouseEvent;
  const a = navLink(e);
  if (a) {
    if (me.metaKey || me.ctrlKey || me.shiftKey || me.button !== 0) return;
    e.preventDefault();
    void navigate(a.href);
    return;
  }
  const target = e.target as HTMLElement;

  const modal = target.closest<HTMLElement>('[data-modal]');
  if (modal && (target === modal || target.closest('[data-close]'))) return closeModal(modal);

  const opener = target.closest<HTMLElement>('[data-open]');
  if (opener) {
    const m = openModal(opener.dataset.open!);
    syncSubmit(m);
    return;
  }

  const sortBtn = target.closest<HTMLButtonElement>('button[data-sort]');
  if (sortBtn) {
    const next = sortBtn.dataset.sort as Sort;
    if (next === sort) return;
    sort = next;
    for (const b of $$('button[data-sort]')) b.setAttribute('aria-selected', String(b === sortBtn));
    void navigate(location.href, { push: false });
    return;
  }

  const btn = target.closest<HTMLButtonElement>('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act!;
  const card = btn.closest<HTMLElement>('article');
  switch (act) {
    case 'save':
    case 'hide':
      return void cardMutation(btn, card!, act);
    case 'archive':
      try {
        openTab(`https://archive.is/${encodeURIComponent(cleanUrl(linkOf(card!)))}`);
      } catch {
        /* invalid URL: nothing to archive */
      }
      return;
    case 'press':
      void navigator.clipboard?.writeText(linkOf(card!)).catch(() => {});
      openTab('https://pressreleased.alwaysdata.net/');
      return;
    case 'yt':
      return playYouTube(btn);
    case 'refresh':
      return void refreshAll(btn);
    case 'delete-saved':
      btn.disabled = true;
      api('DELETE', `/api/saved-links/${card!.dataset.id}`)
        .then(() => {
          invalidate('saved');
          return detachCard(card!).then((m) => settleList([m]));
        })
        .catch(() => (btn.disabled = false));
      return;
    case 'delete-topic':
      return void deleteTopic(btn);
    default:
      return void rowAction(act, btn);
  }
});

document.addEventListener('change', (e) => {
  const modal = (e.target as Element).closest<HTMLElement>('[data-modal]');
  if (modal) syncSubmit(modal);
});

document.addEventListener('submit', (e) => {
  const form = (e.target as Element).closest<HTMLFormElement>('form[data-form]');
  if (!form) return;
  e.preventDefault();
  void submitForm(form);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = $$<HTMLElement>('[data-modal]').find((m) => !m.hidden);
  if (open) closeModal(open);
});

window.addEventListener('popstate', (e) => {
  void navigate(location.href, { push: false, scroll: (e.state as { y?: number } | null)?.y ?? 0 });
});

// ---------- boot ----------

history.scrollRestoration = 'manual';
cache.set(keyFor(new URL(location.href)), { html: app.innerHTML, at: Date.now() });
hydrate();

// Warm the sibling type views once the page is idle, so switching Forums/Blogs/Saved is instant.
const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb) => setTimeout(cb, 300));
window.addEventListener('load', () =>
  setTimeout(() => idle(() => $$<HTMLAnchorElement>('[data-testid^="type-pill-"]:not([aria-current])').forEach((a) => prefetch(a.href))), 500),
);
