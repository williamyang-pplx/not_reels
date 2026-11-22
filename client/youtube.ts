// Feed videos: one YouTube player at a time. Normally one IFrame-API player (youtube-nocookie) in a layer outside
// #app, laid over the chosen card's .yt-box and switched with loadVideoById, so YouTube's embed loads once. When
// the API or its player isn't ready in time, or a video errors in it, videos play in a per-card iframe instead (the
// old player). Autoplay: with the nav switch on, the box nearest the centre of the area under the nav (half visible
// or more) plays once scrolling rests. Everything here lives for the page's life; app.ts calls the exports.

/** The parts of the IFrame Player API this file uses (no @types/youtube dependency). */
interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getVideoData(): { video_id: string };
}
interface YTPlayerOptions {
  host: string;
  videoId: string;
  width: string;
  height: string;
  playerVars: { autoplay: 1; mute: 1; playsinline: 1; rel: 0; start: number; origin: string };
  events: {
    onReady(): void;
    onError(): void;
    onStateChange(e: { data: number }): void;
    onAutoplayBlocked(): void;
  };
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, o: YTPlayerOptions) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const AUTOPLAY_KEY = 'nr-autoplay'; // localStorage: 'off' when switched off; absent means on
const AUTOPLAY_SETTLE_MS = 300; // scrolling must rest this long before a video starts
const PLAYER_TIMEOUT_MS = 5_000; // the API and its player must be ready by then, or this page uses per-card players

let autoplayOn = localStorage.getItem(AUTOPLAY_KEY) !== 'off';
/**
 * The one video, set before it starts (so a video waiting for the API is already "the" video, and stopping it
 * cancels the wait): its box, its ID, how it started, and (per-card) its button and frame.
 */
let current: {
  box: HTMLElement;
  id: string;
  autoplayed: boolean;
  card?: { btn: HTMLElement; frame: HTMLIFrameElement };
} | null = null;
let mode: 'idle' | 'loading' | 'api' | 'frames' = 'idle';
let yt: YTPlayer | null = null;
let ytReady = false; // the player's onReady fired; before it, its methods don't exist
let layer: HTMLElement | null = null;
const resumeAt = new Map<string, number>(); // video ID → whole seconds
let endedId: string | null = null; // the layer video that played to its end (it starts over next time)
const failed = new Set<string>(); // video IDs that errored in the layer player; they use per-card players
/**
 * Boxes in frame, kept by an observer: measuring every box on each settle would force the layout that
 * `content-visibility: auto` skips on off-screen cards.
 */
const inFrame = new Set<HTMLElement>();
let videoObserver: IntersectionObserver | null = null;
let settleTimer = 0;
let autoplayHolds = 0;
let blocked: () => boolean = () => false;

const navBar = () => document.querySelector<HTMLElement>('[data-testid="nav-bar"]');

// ---------- exports (called from app.ts) ----------

/**
 * Once at boot, before the first render: a "don't start videos now" check (the Redlib sheet) and the listeners. A
 * settled scroll re-places the layer and picks a video; resizes and #app size changes (More/Less, images and cards
 * above, loadMore) re-place it. No visibilitychange handler: iOS pauses the player when the app is hidden, and
 * stopping it would lose the place of a video the user unmuted; autoplayPick skips while the page is hidden.
 */
export function initYouTube(isBlocked: () => boolean): void {
  blocked = isBlocked;
  window.addEventListener('scroll', scheduleAutoplay, { passive: true });
  window.addEventListener('resize', placeLayer);
  new ResizeObserver(placeLayer).observe(document.getElementById('app')!);
}

/**
 * After every render and on a switch change: show the switch's state; stop the video if its box left the DOM; and
 * (autoplay on) observe every `.yt-box` against the area under the sticky nav. A box with ratio ≥ 0.5 is in frame
 * (YouTube's rule is more than half visible; ≥ allows for the observer's rounding at exactly the threshold).
 * Autoplay off observes nothing: a tapped video plays on, and a tap still keeps one player.
 */
export function watchVideos(): void {
  document.querySelector('[data-act="autoplay"]')?.setAttribute('aria-pressed', String(autoplayOn));
  if (current && !current.box.isConnected) stopPlayer();
  videoObserver?.disconnect();
  videoObserver = null;
  inFrame.clear();
  clearTimeout(settleTimer);
  if (!autoplayOn) return;
  const top = navBar()?.offsetHeight ?? 0;
  videoObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.intersectionRatio >= 0.5) inFrame.add(e.target as HTMLElement);
        else inFrame.delete(e.target as HTMLElement);
      }
      scheduleAutoplay();
    },
    { rootMargin: `-${top}px 0px 0px 0px`, threshold: [0, 0.5] },
  );
  for (const box of document.querySelectorAll<HTMLElement>('#app .yt-box')) videoObserver.observe(box);
}

/**
 * (Re)start the settle timer: on scroll, observer changes, the sheet closing and when a hold ends. It runs with
 * autoplay off too, to re-place a tapped video's layer.
 */
export function scheduleAutoplay(): void {
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(autoplayPick, AUTOPLAY_SETTLE_MS);
}

/**
 * Keep autoplay from starting until `p` settles (a load that may swap the view), then pick. On the reloadIfStale
 * path `p` never settles: the hold stays on, and the page reloads anyway.
 */
export function holdAutoplay(p: Promise<unknown>): void {
  autoplayHolds++;
  p.catch(() => {}).finally(() => {
    autoplayHolds--;
    scheduleAutoplay();
  });
}

/** The nav switch: keep the choice on this device; off stops an autoplayed video (a tapped one plays on). */
export function toggleAutoplay(): void {
  autoplayOn = !autoplayOn;
  if (autoplayOn) localStorage.removeItem(AUTOPLAY_KEY);
  else localStorage.setItem(AUTOPLAY_KEY, 'off');
  if (!autoplayOn && current?.autoplayed) stopPlayer();
  watchVideos();
}

/** A tap on a thumbnail: cancel a pending pick, so the scroll before the tap can't replace it, and play this box. */
export function tapVideo(btn: HTMLElement): void {
  clearTimeout(settleTimer);
  const box = btn.closest<HTMLElement>('.yt-box');
  if (box) play(box, false);
}

/**
 * Stop the video wherever it plays: a per-card frame goes; the layer is paused (once ready) and hidden, its
 * position kept. A video still waiting for the API is just forgotten.
 */
export function stopPlayer(): void {
  if (!current) return;
  if (current.card) {
    current.card.frame.replaceWith(current.card.btn);
  } else {
    savePosition();
    if (yt && ytReady) yt.pauseVideo();
    if (layer) layer.hidden = true;
  }
  current = null;
}

/** A card leaving the list: stop the video if it plays in that card. */
export function stopPlayerIn(el: Element): void {
  if (current && el.contains(current.box)) stopPlayer();
}

/** Whether a video is playing or waiting to (a stale-view swap then waits: the user is watching). */
export function playerLive(): boolean {
  return current !== null;
}

// ---------- choosing a video ----------

/**
 * The settle timer's work. Re-place the layer first (a box skipped by content-visibility may have moved). Then, with
 * autoplay on and nothing held, hidden or blocked: no box in frame stops the video (it scrolled away); otherwise the
 * box nearest the centre of the area under the nav plays, unless the video is already there.
 */
function autoplayPick(): void {
  placeLayer();
  if (!autoplayOn || autoplayHolds > 0 || document.hidden || blocked()) return;
  if (inFrame.size === 0) return stopPlayer();
  const top = navBar()?.getBoundingClientRect().bottom ?? 0;
  const mid = (top + window.innerHeight) / 2;
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const box of inFrame) {
    const r = box.getBoundingClientRect();
    const distance = Math.abs((r.top + r.bottom) / 2 - mid);
    if (distance < bestDistance) [best, bestDistance] = [box, distance];
  }
  if (best && current?.box !== best) play(best, true);
}

/**
 * Make the box's video the one video and start it: per-card when the API is out or the video failed; in the layer
 * when the API is ready. Otherwise load the API: a tap plays per-card meanwhile, an autoplayed video waits for it
 * (loadApi starts it, if it is still the one).
 */
function play(box: HTMLElement, autoplayed: boolean): void {
  const id = box.querySelector<HTMLElement>('[data-act="yt"]')?.dataset.id;
  if (!id) return;
  stopPlayer();
  current = { box, id, autoplayed };
  if (mode === 'frames' || failed.has(id)) return playInCard();
  if (mode === 'api') return playInLayer();
  if (!autoplayed) playInCard(); // a tap shows a player at once; the next video can use the layer
  loadApi();
}

// ---------- the per-card player (fallback) ----------

/** The old player for `current`: an iframe in place of its thumbnail button (`mute=1` when autoplayed). */
function playInCard(): void {
  const btn = current?.box.querySelector<HTMLElement>('[data-act="yt"]');
  if (!current || !btn) return;
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${current.id}?autoplay=1&rel=0&playsinline=1${current.autoplayed ? '&mute=1' : ''}`;
  iframe.title = btn.getAttribute('aria-label') ?? 'YouTube video';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  iframe.className = 'absolute inset-0 w-full h-full border-0';
  btn.replaceWith(iframe);
  current.card = { btn, frame: iframe };
}

// ---------- the layer player ----------

/**
 * Lay the player over `current`'s box and play it from its saved position: create the player the first time,
 * later `loadVideoById` (which keeps the player's mute state). Nothing is drawn over the player (YouTube's rules).
 */
function playInLayer(): void {
  if (!current) return;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'yt-layer';
    document.body.appendChild(layer);
  }
  layer.hidden = false;
  placeLayer();
  const start = resumeAt.get(current.id) ?? 0;
  endedId = null;
  if (!yt) createPlayer(start);
  else if (ytReady) yt.loadVideoById({ videoId: current.id, startSeconds: start });
  // created but not ready yet: onReady loads `current`
}

/**
 * Load https://www.youtube.com/iframe_api once, and give it and its player PLAYER_TIMEOUT_MS to be ready; past
 * that, this page uses per-card players.
 */
function loadApi(): void {
  if (mode !== 'idle') return;
  mode = 'loading';
  window.onYouTubeIframeAPIReady = () => {
    if (mode !== 'loading') return;
    mode = 'api';
    if (current && !current.card) playInLayer();
  };
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = fallBack;
  document.head.appendChild(script);
  armTimeout();
}

/** Fall back to per-card players unless the player is ready when the timer fires (or no player is due yet). */
function armTimeout(): void {
  window.setTimeout(() => {
    if (!ytReady && (mode === 'loading' || yt)) fallBack();
  }, PLAYER_TIMEOUT_MS);
}

/** The API or its player didn't come: per-card players from now on, starting with the waiting video. */
function fallBack(): void {
  if (mode === 'frames') return;
  mode = 'frames';
  if (layer) layer.hidden = true;
  if (current && !current.card) playInCard();
}

/**
 * The page's one YT.Player, inside the layer: youtube-nocookie host, muted autoplay inline (iOS), our origin for
 * the API's messages.
 */
function createPlayer(start: number): void {
  if (!current || !layer || !window.YT) return;
  const created = current.id;
  const target = document.createElement('div');
  layer.appendChild(target);
  const player = new window.YT.Player(target, {
    host: 'https://www.youtube-nocookie.com',
    videoId: created,
    width: '100%',
    height: '100%',
    playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, start, origin: location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        if (mode === 'frames') return player.pauseVideo(); // timed out meanwhile
        if (!current || current.card) return player.pauseVideo();
        if (current.id !== created) player.loadVideoById({ videoId: current.id, startSeconds: resumeAt.get(current.id) ?? 0 });
      },
      onError: onPlayerError,
      onStateChange: (e) => {
        if (e.data !== 0 || !current || current.card) return; // 0: ended
        endedId = current.id;
        resumeAt.delete(current.id);
      },
      onAutoplayBlocked,
    },
  });
  yt = player;
  armTimeout();
}

/**
 * A video the layer player can't play (2, 5, 100, 101, 150, 153): if it is still the current one (an error can
 * arrive after the next load), remember it and play it per-card instead, with YouTube's own error screen and link.
 */
function onPlayerError(): void {
  if (!current || current.card || !yt || yt.getVideoData().video_id !== current.id) return;
  const { box, id, autoplayed } = current;
  failed.add(id);
  stopPlayer();
  current = { box, id, autoplayed };
  playInCard();
}

/**
 * iOS refused to play with sound: mute and play (the user unmutes again). Already muted (Low Power Mode): leave
 * YouTube's play button showing.
 */
function onAutoplayBlocked(): void {
  if (yt && ytReady && !yt.isMuted()) {
    yt.mute();
    yt.playVideo();
  }
}

/** Put the layer exactly over the playing box, in page coordinates, so it scrolls with the page natively. */
function placeLayer(): void {
  if (!layer || layer.hidden || !current || current.card) return;
  const r = current.box.getBoundingClientRect();
  if (!r.width) return; // a card skipped by content-visibility: keep the last place
  layer.style.top = `${r.top + window.scrollY}px`;
  layer.style.left = `${r.left + window.scrollX}px`;
  layer.style.width = `${r.width}px`;
  layer.style.height = `${r.height}px`;
}

/** Remember where the layer video is, in whole seconds (an ended video starts over). */
function savePosition(): void {
  if (yt && ytReady && current && !current.card && endedId !== current.id) {
    resumeAt.set(current.id, Math.floor(yt.getCurrentTime()));
  }
}
