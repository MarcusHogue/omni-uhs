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
text is. Each one keeps the reading surface as a *window* on the desktop
pattern, which is both what those systems actually did and the reason black
Amiga text never ends up on Amiga blue. Text size is a separate setting, so
Workbench at 20px is as readable as anything else.

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
| **Fandom / wiki.gg** | Route and per-wiki licence gating are in place (`WIKI_ALLOWLIST`); a `-NC` licence forces `personalUseOnly`. Not wired into search yet. |

GameFAQs, Neoseeker, Fextralife and Steam Guides are deliberately **not**
implemented — all-rights-reserved or ToS-restricted.

---

## Operations

See [docs/SETUP.md](docs/SETUP.md) for the full runbook.

- **Images:** `ghcr.io/marcushogue/omni-uhs-web` and
  `ghcr.io/marcushogue/omni-uhs-proxy`, tagged `latest` and by commit SHA.
  Published on push to `main`, so they do not exist until this branch merges —
  build from source with `--build` until then. The packages inherit this
  repository's visibility, so pulling needs a `read:packages` login while it is
  private.
- **Updates:** on the host, `docker compose pull && docker compose up -d`.
- **Backups:** weekly tar of the `cache-data` and `ts-state` volumes. Your
  library lives in the browser — use Settings → Export for that.
- **Health:** `/healthz` on both containers.

---

## Legal & attribution

This is a personal-use project and behaves like one:

- **No redistribution.** No sharing, publishing or export of personal-use-only
  content. Library export deliberately excludes it and tells you what it left
  out.
- **UHS files** are the work of the Universal Hint System (Jason Strautman) and
  its contributors. They are marked `personalUseOnly` and never leave the
  device. Distribution would require written permission first.
- **Registration-gated hints** (`incentive` hunks) are not decoded by default.
  There is a Settings toggle with a note explaining what it is.
- **CC-BY-SA content** carries its attribution and licence into the Library and
  the Reader, as the licence requires.
- **Be gentle.** uhs-hints.com has been dormant since ~2015: the catalogue is
  one request a day and files are cached forever.

### Prior art

- **freeuhs** (Aaron Black, Unlicense) — the reference this parser was ported
  from, and the source of truth for the ciphers and hunk layout.
- **OpenUHS** (GPL-3.0) — consulted as an oracle only; no code reproduced.
