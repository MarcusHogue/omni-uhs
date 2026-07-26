# Omni UHS

A personal, spoiler-safe, **fully offline** game hint reader.

It reads **UHS** (Universal Hint System) hint files — all four generations, 88a
through 96a — with the classic progressive-reveal UX, and normalizes other open
hint sources (IF Archive, IFDB, StrategyWiki) into the same shape. Everything
you download is stored in the browser and readable with the network switched
off. The server side runs in Docker Compose behind a Tailscale sidecar, so it is
reachable from your phone over HTTPS with no port forwarding.

> **Personal use only.** Nothing here redistributes hint content. No public
> hosting, no App Store submission, no sharing features. See
> [Legal](#legal--attribution).

---

## Quick start

```bash
# Local stack, no Tailscale, on http://localhost:8081
docker compose -f docker-compose.local.yml up -d --build
```

Then open <http://localhost:8081>, search for a game, download it, and turn off
your Wi-Fi — it keeps working.

For the tailnet deployment (this is the one you want on a phone):

```bash
cp .env.example .env      # put your TS_AUTHKEY and a real contact address in it
docker compose up -d --build
```

The app appears at `https://omni-uhs.<your-tailnet>.ts.net`. Requires
**MagicDNS** and **HTTPS certificates** enabled in the tailnet admin console.

**Full instructions:** [docs/SETUP.md](docs/SETUP.md) ·
**Synology NAS:** [docs/SYNOLOGY.md](docs/SYNOLOGY.md)

### On the phone: add it to the Home Screen

Not optional if you care about your library. An **installed** iOS web app is
exempt from Safari's 7-day eviction of unused sites' storage; a browser tab is
not. Open the tailnet URL in Safari → Share → *Add to Home Screen*, and launch
it from there. The app also asks for durable storage on first run and shows the
result in Settings.

---

## What it does

| Screen | |
|---|---|
| **Library** | Everything downloaded, with an offline badge, size, source and licence. Filter-as-you-type runs against IndexedDB, so it works in airplane mode. |
| **Search** | One box, fanned out across every source. Results group by title, so a game that exists in three places appears once with three badges. A source that is down produces a warning, not an error. |
| **Browse** | Per-source drill-down: the UHS A–Z index, IF Archive paths, StrategyWiki page prefixes. |
| **Reader** | Subject tree, tap-to-reveal-one-hint-at-a-time, monospace runs, embedded images with tappable hotspots, internal links. Reveal state persists per document. |
| **Settings** | Themes, text size, storage usage and durability, registration-gated-hint toggle, library export/import. |

**Spoiler safety is structural.** Hint *n+1* is not rendered until hint *n* has
been revealed by an explicit tap — not hidden with CSS, not rendered off-screen:
absent from the DOM. The reader's find field searches section and question
titles only, never hint bodies, because a search that surfaces answers is a
search that spoils.

**The interface gets out of the way.** One line of header, one row of tabs, and
both slide off as soon as you scroll into a hint. In the reader there is a
single bar — back, where you are, find — and the breadcrumb trail and source
attribution stay folded behind it until you ask.

## Themes

Eight of them, in Settings. `Auto`, `Dark` and `Light` are the modern set; then
there is **Windows 95**, **Windows 3.1**, **System 7**, **Mac OS 9**, **Amiga
Workbench 1.3** and **DOS**.

The retro themes are colour, type and chrome only — a theme is a block of CSS
variables and nothing else, so it cannot change where you tap or how large the
text is. Each one keeps the reading surface as a *window* inset on the desktop,
which is both what those systems actually did and the reason black Amiga text
never ends up on Amiga blue. Text size is a separate setting, so Workbench at
20px is as readable as anything else.

They are meant to be told apart at a glance, so each takes the one or two
details that actually identified it: 95 has the teal desktop, the gradient title
bar and a taskbar; 3.1 has a grey Program Manager desktop, a *flat* navy title
bar, hard black bevels and a menu bar instead; System 7 has the striped drag
bar, a hard drop shadow and a dithered Finder desktop; Mac OS 9 is pinstriped
platinum; Workbench 1.3 is white windows with a hatched drag bar and orange
selection on #0055AA; DOS is a blue text-mode screen inside a double-line box.

Every text/background pair in every theme was measured at 4.5:1 or better —
retro palettes are not an excuse for grey-on-blue.

---

## Repository layout

```
web/                    React + TypeScript + Vite PWA
  src/parser/           pure TS, no DOM/React/Node — portable to Swift
    uhs/                the UHS binary format
    wikitext/           MediaWiki → AST
    invisiclues/        IF Archive text hints → AST
    ast.ts              the shared AST every source normalizes to
  src/storage/          IndexedDB, download pipeline, export/import
  src/api/              typed client for the proxy
  src/ui/               React components
  test/fixtures/        synthetic .uhs files + expected JSON
  tools/                fixture generator, AST dumper, fixture fetcher
proxy/                  Node 22 + Fastify: caching, allowlisting, catalogues
docker-compose.yml      ts-sidecar + web + proxy (tailnet)
docker-compose.local.yml  web + proxy on localhost
docs/SETUP.md           running it locally and on a tailnet
docs/SYNOLOGY.md        running it on a Synology NAS
```

### The parser is deliberately isolated

`web/src/parser/` imports nothing — not React, not the DOM, not `node:*`. It
takes `Uint8Array`/`string` and returns plain objects. A lint rule enforces
this, because the same parser is going to be re-implemented in Swift for a
native iOS client, and both implementations must pass the identical test
vectors in `web/test/fixtures/`.

```bash
# Dump any .uhs file's AST, or a spoiler-free outline of it
npm run dump --workspace web -- path/to/file.uhs --tree
npm run dump --workspace web -- path/to/file.uhs > ast.json
```

---

## Development

```bash
npm install
npm test                              # unit + integration tests
npm run typecheck && npm run lint
npm run dev --workspace web           # Vite dev server, proxies /api to :8080
npm run dev --workspace proxy         # Fastify with watch
```

End-to-end (needs the stack running):

```bash
docker compose -f docker-compose.local.yml up -d --build
npm run test:e2e --workspace web
```

The e2e suite is the definition of done: download two games, go offline,
cold-launch, read and reveal hints in both, asserting zero network requests and
zero console errors. It runs in Chromium at phone size; Safari-specific
behaviour (Add to Home Screen, the eviction exemption) is a manual check on a
real iPhone.

### Test fixtures

Real hint files are copyrighted and are **never committed**. The committed
fixtures are hand-authored by `web/tools/fixtures/definitions.ts` — every byte
is ours — and cover a pure 88a file, a 95a file with `nesthint`/`text`/an
unknown hunk/a zero checksum, and a 96a file with `hyperpng` hotspots.

```bash
npm run fixtures --workspace web        # regenerate them
npm run fetch-fixtures --workspace web  # pull a few real files into a gitignored dir
```

The parser has also been checked by hand against real files (Adventure 660,
Zork I, Myst, Riven, Nancy Drew 31 — the last a 4.8 MB 96a file with 33 embedded
images), all of which parse with no warnings.

---

## The proxy

The browser cannot fetch these sites directly (CORS), and they should not be
hammered, so everything goes through `proxy/`:

- **Allowlist.** Hostnames are checked after URL parsing and again on every
  redirect hop. `GET`/`HEAD` only, no request bodies. This is the SSRF boundary.
- **Cache.** Content-addressed blobs on disk plus a SQLite (WAL) index. Fresh
  entries never touch the network; stale ones revalidate with
  `If-None-Match`/`If-Modified-Since`; if the upstream then fails, the stale
  copy is served rather than an error.
- **Politeness.** Two concurrent requests per host, `Retry-After` honoured,
  single-flight coalescing (N simultaneous misses ⇒ one upstream fetch), an
  honest `User-Agent` — set yours in `.env`.

### Sources

| Source | Notes |
|---|---|
| **uhs-hints.com** | The catalogue comes from the reader's own `/cgi-bin/update.cgi` — 591 titles in a single request, refreshed at most daily, with the per-letter HTML index as a fallback. Search runs against the local copy and never touches the site. |
| **IF Archive** | `indexes/Master-Index.xml` (~15 MB) is fetched daily and the hint-bearing subtrees indexed into SQLite. Includes InvisiClues transcriptions, which are already question → progressive answers. |
| **IFDB** | Metadata and search. Cloudflare-fronted: it answers 403 without a real `User-Agent`, so the honest one is mandatory rather than merely polite. |
| **StrategyWiki** | MediaWiki API, CC-BY-SA 4.0. Page URL and revision id are recorded and displayed. |
| **Fandom / wiki.gg** | Searchable, browsable and downloadable, one wiki at a time, added from the app or seeded with `WIKI_ALLOWLIST`. Each is asked for its own script path and licence on first contact; a `-NC` licence forces `personalUseOnly`. A whole wiki arrives as one game: the proxy picks its most likely guidance pages, the parser re-shapes them so answers reveal one at a time, and pictures come down with them (see below). |

GameFAQs, Neoseeker, Fextralife and Steam Guides are deliberately **not**
implemented — all-rights-reserved or ToS-restricted.

#### Reference wikis (Fandom, wiki.gg)

Three things make these different from every other source here.

**They are platforms, not sites.** Between them they host hundreds of thousands
of wikis about everything — books, television, brands — and neither exposes a
usable "games only" filter: Fandom's discovery API answers 403 to anything that
is not a browser, its vertical parameter is gone, and wiki.gg has no index API
at all. So the filter is you, one wiki at a time. Search for a game, tap
**Look for a wiki**, and the proxy asks the addresses a wiki for it would
plausibly live at — `blue-prince.fandom.com`, `blueprince.wiki.gg` — reporting
each one's real name and licence. Tap **Add** and it is searchable immediately:
the allowlist lives in the cache database, so there is nothing to restart.

Guessing from a name does miss things — Zelda's wiki is `zelda.fandom.com`,
which no slugification of "Tears of the Kingdom" will reach — so pasting a wiki
address from a browser tab is always accepted and skips the guessing. Settings
lists what you have added and removes it again. `WIKI_ALLOWLIST` still exists
for seeding a fresh container; anything named there is pinned and the app will
not remove it.

Only `*.fandom.com` and `*.wiki.gg` can be added, from the app or the
environment. Every other upstream keeps exact-hostname matching against
`UPSTREAM_ALLOWLIST` at boot, so nothing reachable from the UI can point the
fetcher at an internal address.

**They are reference works, not walkthroughs.** A wiki page states the answer
in its first sentence and marks nothing as a spoiler, so rendering one as
written would give away the puzzle you opened it to get a nudge on. Wiki pages
are therefore re-shaped: each section heading becomes a question and its
paragraphs become hints revealed one at a time, in the order the page tells it —
the same progressive contract as a UHS file, minus the hand-authored ordering.
Nothing reorders the hints *within* a section: a wiki section is often a
sequence ("first do this, then that"), and sorting by length would shuffle the
steps to gain a spoiler gradation the source never had.

**Wikitext hides text in three places.** A page is not prose with a bit of
markup on it, and reading it as though it were loses words that matter. Templates
stand in for them mid-sentence: `blueprince.wiki.gg` writes a dartboard step as
`{{ColorText|add|Blue}} is addition`, where the colour *is* the answer. Container
templates hold whole worked examples, nested several deep. And some words are not
in the page at all — Animal Well writes the game's name as `{{AW}}`, whose text
lives in the template's definition on the wiki, so the sentence arrived with a
hole in it.

The first two are parsed: a styling template gives up its display text, a
container gives up its body, and both resolve inside-out so nesting works. The
third cannot be, so the download asks the wiki with `action=expandtemplates` —
batched, cached, and only for the calls that would otherwise be dropped. All of
it is bounded: an expansion that comes back as a block rather than a phrase is
still layout, and still discarded.

**Which pages, and which of them are guidance.** A wiki is hundreds of pages
and most of them are not hints. The proxy picks about sixty by weighing four
signals — links from the wiki's own hand-curated main page, categories whose
*names* carry guidance vocabulary (`Bosses (Hollow Knight)`, `Secret rabbits`),
two searches, and a whole-wiki enumeration as the floor — and reports where they
came from. An earlier version matched a fixed list of category names, which
found fifty pages on Blue Prince and *zero* on Hollow Knight, Outer Wilds and
Return of the Obra Dinn.

Sections are then scored on how instructional their language is, measured
against 318 real sections across five wikis: a "How To" or "Strategy" section
runs 7–14 second-person and imperative matches per 100 words against a median of
0.9. The score **orders and never removes.** It is blind to a whole genre —
Return of the Obra Dinn scores zero everywhere, because its answers are facts
("this man is Alexander Booth") rather than instructions, and those are the most
spoiler-bearing pages on the wiki. So a document leads with a **Likely
guidance** index of its twenty strongest sections, marks those rows, and leaves
everything else exactly where it is and unlabelled. Only headings that are never
a hint on any wiki — References, Gallery, Trivia, Appearances, Soundtrack, In
other languages — are dropped outright.

**Some answers are pictures.** Blue Prince's puzzles are scans of in-game
documents; the text around them says little more than "see the diagram". Those
are downloaded with the game at 640px and stored offline — Blue Prince's 277
pictures come to about 16 MB that way, where their originals average over a
megabyte each — and tapping one fetches the original from the wiki when you are
online. A picture hangs off the *hint*, not
the section, so a solution scan is not on screen until the hint above it has
been revealed by a tap. Neither platform states a licence for its images, so a
game carrying them is `personalUseOnly`: it stays out of a shareable export, and
the export says the image count as the reason. Turn the whole thing off in
Settings if you would rather have the text alone.

**Their licences vary per wiki.** Each wiki is asked for its own on first
contact and the answer is cached; `-NC` (common on ex-Gamepedia game wikis)
marks everything from it `personalUseOnly`, which keeps it out of a shareable
export while leaving it in a full backup. Attribution — page URL and revision
id — is recorded either way.

Fandom's terms are stricter on paper about automated retrieval than
StrategyWiki's. What this does is personal-use, low-volume, cached, attributed
reading of specific pages through the documented API, with an honest
`User-Agent` — but it is worth knowing the difference rather than assuming
every wiki has the same posture. Neither platform is crawled.

---

## Operations

See [docs/SETUP.md](docs/SETUP.md) for the full runbook.

- **Images:** `ghcr.io/marcushogue/omni-uhs-web` and
  `ghcr.io/marcushogue/omni-uhs-proxy`, tagged `latest` and by commit SHA, both
  full and short.
  Published on push to `main`. Both are public — no `docker login` needed.
- **Updates:** on the host, `docker compose pull && docker compose up -d`.
- **Backups:** weekly tar of the `cache-data` and `ts-state` volumes. Your
  library lives in the browser — Settings → Export & import has a **full
  backup** (every title, reveal progress and settings, behind a personal-use
  confirmation) and a **shareable export** (only what carries no redistribution
  restriction).
- **Logs:** both containers log to stdout. The proxy emits newline-delimited
  JSON tagged by component — `http`, `upstream`, `cache`, `catalog`, `search` —
  so `docker logs … | jq 'select(.component=="upstream")'` shows exactly what
  left the machine. `LOG_LEVEL=debug` adds cache hits and misses.
- **Versions:** both images are stamped with their build SHA; the proxy reports
  its own at `/api/version` and the app compares it with the one baked into the
  bundle. A waiting update shows a dismissible one-liner in the app and a full
  account in Settings — nothing ever reloads itself mid-hint.
- **Health:** `/healthz` on both containers, excluded from both access logs.

---

## Legal & attribution

This is a personal-use project and behaves like one:

- **No redistribution.** There is no share, publish or upload path anywhere in
  the app. The **shareable export** excludes personal-use-only content and
  lists what it left out. The **full backup** does include it — a backup that
  silently dropped most of your library would not be a backup — so it requires
  an explicit personal-use confirmation and stamps the notice into the archive.
  Moving your own files between your own devices is personal use; putting that
  archive somewhere others can reach it is not.
- **UHS files** are the work of the Universal Hint System (Jason Strautman) and
  its contributors. They are marked `personalUseOnly`: excluded from a shareable
  export, and leaving the device only in a backup you have confirmed is for your
  own use. Distribution would require written permission first.
- **Registration-gated hints** (`incentive` hunks) are not decoded by default.
  There is a Settings toggle with a note explaining what it is.
- **CC-BY-SA content** carries its attribution and licence into the Library and
  the Reader, as the licence requires.
- **Be gentle.** uhs-hints.com has been dormant since ~2015: the catalogue is
  one request a day and files are cached forever.

### Licence

The **code** is MIT — see [LICENSE](LICENSE).

That covers this repository and nothing else. It grants no rights to the hint
content the app reads: UHS files remain the work of the Universal Hint System
and its contributors and are personal-use-only, IF Archive material belongs to
its individual authors, and wiki content keeps whatever licence the wiki states.
No hint content is in this repository, and none of it becomes MIT-licensed by
being read with this software.

### Prior art

- **freeuhs** (Aaron Black, Unlicense) — the reference this parser was ported
  from, and the source of truth for the ciphers and hunk layout.
- **OpenUHS** (GPL-3.0) — consulted as an oracle only; no code reproduced.
