// Trimmed copies of real Redlib output (ghcr.io/nachtalb/redlib v0.36, REDLIB_ENABLE_RSS=on, no REDLIB_FULL_URL).

/** <content:encoded> bodies, as rss-parser hands them over (CDATA unwrapped). */
export const GALLERY_CONTENT =
  '<a href="/preview/pre/6m6frwds2o1i1.jpeg?width=4284&format=pjpg&auto=webp&s=443c"><img src="/preview/pre/6m6frwds2o1i1.jpeg?width=4284&format=pjpg&auto=webp&s=443c" /></a><br/>' +
  '<a href="/preview/pre/x4qkbzds2o1i1.jpeg?width=3024&amp;format=pjpg&amp;s=99a7"><img src="/preview/pre/x4qkbzds2o1i1.jpeg?width=3024&amp;format=pjpg&amp;s=99a7" /></a><br/>';

export const VIDEO_CONTENT =
  '<video controls preload="metadata" poster="/preview/external-pre/ZHN1aWls.png?format=pjpg&auto=webp&s=c49d" width="100%">' +
  '<source src="/vid/z541z5rqzm1i1/CMAF/1080.mp4" type="video/mp4" /></video><br/>' +
  '<!-- SC_OFF --><div class="md"><p>I hope you like it :3 </p> <p><a href="https://github.com/x/Nebula">Github</a></p> </div><!-- SC_ON -->';

export const TEXT_CONTENT =
  '<!-- SC_OFF --><div class="md"><p>The melting pot is a free-for-all music sharing thread.</p> <ul> <li>Anything you&#39;ve been listening to.</li> </ul> </div><!-- SC_ON -->';

export const LINK_CONTENT = "<a href='/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/'>Comments</a>";

/** Items of Redlib's /r/listentothis/hot.rss, as rss-parser returns them. */
export const RSS_ITEMS = [
  {
    title: 'Music Melting Pot [Week of November 09, 2026]',
    link: '/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/',
    guid: '/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/',
    author: 'AutoModerator',
    isoDate: '2026-11-09T01:00:07.000Z',
    'content:encoded': TEXT_CONTENT,
  },
  {
    title: 'Neo Boys - Rich Man’s Dreams [punk] (1980)',
    link: '/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/',
    guid: '/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/',
    author: 'Irish_Neil',
    isoDate: '2026-11-15T08:38:49.000Z',
    'content:encoded': LINK_CONTENT,
  },
  {
    title: 'Concrete City, PA, USA',
    link: '/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/',
    guid: '/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/',
    author: 'gabagoo3',
    isoDate: '2026-11-15T01:00:00.000Z',
    'content:encoded': GALLERY_CONTENT,
  },
];

/** Redlib's /r/listentothis/hot page: a stickied post with flair, a YouTube link post, a gallery post. */
export const LISTING_HTML = `
<div id="posts">
<div class="post stickied" id="1xre9hw">
  <p class="post_header"> <a class="post_subreddit" href="/r/listentothis">r/listentothis</a> </p>
  <h2 class="post_title"> <a href="/r/listentothis/search?q=flair_name%3A%22melting pot%22&restrict_sr=on" class="post_flair"><span>melting pot</span></a> <a href="/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/">Music Melting Pot [Week of November 09, 2026]</a> </h2>
  <div class="post_score" title="18">18<span class="label"> Upvotes</span></div>
  <div class="post_body post_preview"><p>Format links as [Artist](<a href="https://www.yoururlhere.com">https://www.yoururlhere.com</a>)</p></div>
  <div class="post_footer"> <a href="/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/" class="post_comments" title="35 comments">35 comments</a> </div>
</div>
<div class="post" id="1xwqj5c">
  <h2 class="post_title"> <a href="/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/">Neo Boys - Rich Man’s Dreams [punk] (1980)</a> </h2>
  <a class="post_thumbnail" href="https://www.youtube.com/watch?v=OpG_9PRNzOA&#38;list=x" rel="nofollow"><img src="/thumb/b/abc.jpg"></a>
  <div class="post_score" title="Hidden">&#x2022;<span class="label"> Upvotes</span></div>
  <div class="post_footer"> <a href="/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/" class="post_comments" title="1 comment">1 comment</a> </div>
</div>
<div class="post" id="1xwh3rz">
  <h2 class="post_title"> <a href="/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/">Concrete City, PA, USA</a> </h2>
  <a class="post_thumbnail" href="/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/"><img src="/preview/pre/6m6frwds2o1i1.jpeg?width=140"></a>
  <div class="post_score" title="197">197<span class="label"> Upvotes</span></div>
  <div class="post_footer"> <a href="/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/" class="post_comments" title="7 comments">7 comments</a> </div>
</div>
</div>`;
