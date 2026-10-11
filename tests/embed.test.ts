import { describe, it, expect } from 'vitest';
import { detectEmbedKind, extractYouTubeId, extractRedditPost } from '../src/lib/embed';

describe('detectEmbedKind', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/shorts/abc12345678', 'youtube'],
    ['https://www.reddit.com/r/typescript/comments/abc123/hello/', 'reddit'],
    ['https://reddit.com/r/typescript/', 'reddit'],
    ['https://old.reddit.com/r/typescript/comments/abc123/hello/', 'reddit'],
    ['https://np.reddit.com/r/typescript/comments/abc123/hello/', 'reddit'],
    ['https://m.reddit.com/r/typescript/comments/abc123/hello/', 'reddit'],
    ['https://news.ycombinator.com/item?id=1', null],
    ['https://example.com/video?v=dQw4w9WgXcQ', null],
    ['not a url', null],
    ['', null],
  ])('detects %s as %s', (link, expected) => {
    expect(detectEmbedKind(link)).toBe(expected);
  });
});

describe('extractYouTubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts id from %s', (link, expected) => {
    expect(extractYouTubeId(link)).toBe(expected);
  });

  it.each([
    ['https://www.youtube.com/'],
    ['https://www.youtube.com/watch'],
    ['https://www.youtube.com/watch?v=tooshort'],
    ['https://www.youtube.com/watch?v=way_too_long_id_here'],
    ['https://youtu.be/'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['not a url'],
    [''],
  ])('returns null for %s', (link) => {
    expect(extractYouTubeId(link)).toBeNull();
  });
});

describe('extractRedditPost', () => {
  it.each([
    [
      'https://www.reddit.com/r/typescript/comments/abc123/hello_world/',
      { subreddit: 'typescript', postId: 'abc123', slug: 'hello_world' },
    ],
    [
      'https://old.reddit.com/r/typescript/comments/abc123/hello_world/',
      { subreddit: 'typescript', postId: 'abc123', slug: 'hello_world' },
    ],
    [
      'https://np.reddit.com/r/typescript/comments/abc123/hello_world',
      { subreddit: 'typescript', postId: 'abc123', slug: 'hello_world' },
    ],
    [
      'https://www.reddit.com/r/typescript/comments/abc123/hello_world/?share=true',
      { subreddit: 'typescript', postId: 'abc123', slug: 'hello_world' },
    ],
    [
      'https://www.reddit.com/r/typescript/comments/abc123/',
      { subreddit: 'typescript', postId: 'abc123', slug: '' },
    ],
    [
      'https://www.reddit.com/r/Urban_Exploration/comments/1a2b3c4/deep_dive/',
      { subreddit: 'Urban_Exploration', postId: '1a2b3c4', slug: 'deep_dive' },
    ],
  ])('extracts post from %s', (link, expected) => {
    expect(extractRedditPost(link)).toEqual(expected);
  });

  it.each([
    ['https://www.reddit.com/r/typescript/'],
    ['https://www.reddit.com/r/typescript'],
    ['https://www.reddit.com/user/someone/'],
    ['https://www.reddit.com/'],
    ['https://www.reddit.com/r/typescript/comments/BAD-ID!/slug/'],
    ['https://www.reddit.com/r/bad space/comments/abc123/slug/'],
    ['https://example.com/r/typescript/comments/abc123/slug/'],
    ['not a url'],
    [''],
  ])('returns null for %s', (link) => {
    expect(extractRedditPost(link)).toBeNull();
  });
});
