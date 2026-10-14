# Feed sources from not-brainrot.fly.dev

Snapshot of every feed registered on https://not-brainrot.fly.dev/, taken from `GET /api/feeds` on 2026-10-13.
51 feeds: 39 active, 12 paused. Feeds are paused after 5 fetch errors in a row, and most of the paused ones here are Reddit feeds.

- `feeds.json`: name, url, type, topics, isActive and sourceKind for each feed. Each entry can be re-created with `POST /api/feeds` (drop `isActive` and `sourceKind`).
- `topics.json`: the topic slugs and labels the feeds use. Create these first.
- `feeds.opml`: the RSS feeds as OPML, grouped by first topic, to import into another reader. The `local/` feed is skipped because only this app can read it.

To load them into a local instance (topics first, then feeds):

```sh
jq -c '.[]' examples/sources/topics.json | while read -r t; do curl -s -X POST localhost:4000/api/topics -H 'content-type: application/json' -d "$t"; done
jq -c '.[] | {name, url, type, topics}' examples/sources/feeds.json | while read -r f; do curl -s -X POST localhost:4000/api/feeds -H 'content-type: application/json' -d "$f"; done
```

| Type | Topics | Name | URL | Active |
|---|---|---|---|---|
| BLOG | COOL_BLOGS | CJ Quines | https://blog.cjquines.com/atom.xml | yes |
| BLOG | LIT | n_plus_one_mag | https://www.nplusonemag.com/feed/ | yes |
| BLOG | LIT | New Yorker (Literature) | https://www.newyorker.com/feed/fiction-and-poetry/rss | yes |
| BLOG | LIT | Paris Review | https://www.theparisreview.org/blog/feed/ | yes |
| BLOG | LIT, YOUTUBE | oliSUNvia | https://www.youtube.com/feeds/videos.xml?channel_id=UCVHxJghKAB_kA_5LMM8MD3w | yes |
| BLOG | LIT, YOUTUBE | Philosophize This | https://www.youtube.com/feeds/videos.xml?channel_id=UCjnpuIGovFFUBLG5BeHzTag | yes |
| BLOG | TECH | Alex Harri | https://alexharri.com/rss.xml | yes |
| BLOG | TECH | Ben Eater | https://www.youtube.com/feeds/videos.xml?channel_id=UCS0N5baNlQWJCUrhCEo8WlA | yes |
| BLOG | TECH | Chip Huyen | https://huyenchip.com/feed.xml | yes |
| BLOG | TECH | Dan Lu | https://danluu.com/atom.xml | yes |
| BLOG | TECH | jdh | https://www.youtube.com/feeds/videos.xml?channel_id=UCUzQJ3JBuQ9w-po4TXRJHiA | yes |
| BLOG | TECH | Julia Evans | https://jvns.ca/atom.xml | yes |
| BLOG | TECH | Lillian Weng | https://lilianweng.github.io/index.xml | yes |
| BLOG | TECH | OS Dev Popovicu | https://popovicu.com/rss.xml | yes |
| BLOG | TECH | tgrcode | https://tgrcode.com/rss | yes |
| BLOG | TECH | Welch Labs | https://www.youtube.com/feeds/videos.xml?channel_id=UConVfxXodg78Tzh5nNu85Ew | yes |
| BLOG | TECH | Yannic Kilcher | https://www.youtube.com/feeds/videos.xml?channel_id=UCZHmQk67mSJgfCCTn7xBfew | yes |
| BLOG | YOUTUBE | 3blue1brown | https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw | yes |
| BLOG | YOUTUBE | Aidan Robbins | https://www.youtube.com/feeds/videos.xml?channel_id=UCcOTVI8YJJud1A6aRYrV4sg | yes |
| BLOG | YOUTUBE | GIFGAS | https://www.youtube.com/feeds/videos.xml?channel_id=UC8iPVSFr42KUFf8DKsmnvSw | yes |
| BLOG | YOUTUBE | Jacob Geller | https://www.youtube.com/feeds/videos.xml?channel_id=UCeTfBygNb1TahcNpZyELO8g | yes |
| BLOG | YOUTUBE | Peter Santenello | https://www.youtube.com/feeds/videos.xml?channel_id=UC3Vuq4Q1bKFtAiKYlwRv3oA | paused |
| BLOG | YOUTUBE | Shiey | https://www.youtube.com/feeds/videos.xml?channel_id=UCpXwMqnXfJzazKS5fJ8nrVw | yes |
| FORUM | LIT | Aeon | https://aeon.co/feed.rss | yes |
| FORUM | LIT | Arts and Letters Daily | https://www.aldaily.com/feed/ | yes |
| FORUM | LIT | Book Riot | https://bookriot.com/feed/ | yes |
| FORUM | LIT | Electric Literature | https://electricliterature.com/feed/ | yes |
| FORUM | LIT | Lithub | https://lithub.com/feed/ | yes |
| FORUM | MUSIC | Pitchfork | https://pitchfork.com/feed/feed-album-reviews/rss | yes |
| FORUM | MUSIC | Rate Your Music | local/rym_music_recs | yes |
| FORUM | MUSIC, REDDIT | r/listentothis | https://www.reddit.com/r/listentothis/hot.rss | paused |
| FORUM | MUSIC, REDDIT | r/progrockmusic | https://www.reddit.com/r/progrockmusic/hot.rss | paused |
| FORUM | MUSIC, REDDIT | r/rateyourmusic | https://www.reddit.com/r/rateyourmusic/hot.rss | paused |
| FORUM | NEWS | Al Jazeera | https://www.aljazeera.com/xml/rss/all.xml | yes |
| FORUM | NEWS | Associated Press (AP) | https://feedx.net/rss/ap.xml | yes |
| FORUM | NEWS | BBC | https://feeds.bbci.co.uk/news/rss.xml?edition=us | paused |
| FORUM | NEWS | LA Times (Opinion) | https://www.latimes.com/politics/rss2.0.xml#nt=0000016c-0bf3-d57d-afed-2fff84fd0000-1col-7030col1 | paused |
| FORUM | NEWS | New York Times | https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml | yes |
| FORUM | NEWS | New Yorker | https://www.newyorker.com/feed/latest/rss | yes |
| FORUM | NEWS | The Economist | https://www.economist.com/finance-and-economics/rss.xml | yes |
| FORUM | NEWS | The Guardian | https://www.theguardian.com/uk/rss | paused |
| FORUM | NEWS | Wired | https://www.wired.com/feed/category/backchannel/latest/rss | yes |
| FORUM | NEWS | WSJ (Business) | https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness | yes |
| FORUM | NEWS | WSJ (World News) | https://feeds.content.dowjones.io/public/rss/RSSWorldNews | paused |
| FORUM | REDDIT | r/AlternateAngles | https://www.reddit.com/r/AlternateAngles/hot.rss | paused |
| FORUM | REDDIT | r/InternetMysteries | https://www.reddit.com/r/InternetMysteries/hot.rss | paused |
| FORUM | REDDIT | r/tripreports | https://www.reddit.com/r/tripreports/hot.rss | yes |
| FORUM | REDDIT | r/urbanexploration | https://reddit.com/r/urbanexploration/hot.rss | paused |
| FORUM | REDDIT, TECH | r/unixporn | https://www.reddit.com/r/unixporn/hot.rss | paused |
| FORUM | TECH | Hacker News | https://news.ycombinator.com/rss | yes |
| FORUM | TECH | Smol AI | https://news.smol.ai/rss.xml | yes |
