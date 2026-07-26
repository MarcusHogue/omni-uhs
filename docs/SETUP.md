# Running Omni UHS

Two deployments, same two containers:

| | What you get | Use it for |
|---|---|---|
| **Local** (`docker-compose.local.yml`) | `http://localhost:8081`, no TLS, no Tailscale | Your own machine, development, trying it out |
| **Tailnet** (`docker-compose.yml`) | `https://omni-uhs.<tailnet>.ts.net`, real certificate | Reading on your phone |

The phone case genuinely needs the tailnet one. iOS only installs a PWA and only
runs a service worker over HTTPS with a certificate it trusts, and `*.ts.net`
names get a real Let's Encrypt certificate without any port forwarding.

---

## 1. Local

**Needs:** Docker Engine 24+ (or Docker Desktop) with the Compose plugin.

```bash
git clone https://github.com/MarcusHogue/omni-uhs.git
cd omni-uhs
docker compose -f docker-compose.local.yml up -d --build
```

Open <http://localhost:8081>. Search for a game, download it, then turn off your
Wi-Fi — it keeps working. (`localhost` counts as a secure context in every
browser, so IndexedDB and the service worker behave exactly as they do over
HTTPS.)

Useful commands:

```bash
docker compose -f docker-compose.local.yml logs -f          # follow logs
docker compose -f docker-compose.local.yml pull             # get new images
docker compose -f docker-compose.local.yml up -d            # apply them
docker compose -f docker-compose.local.yml down             # stop
docker compose -f docker-compose.local.yml down -v          # stop + drop the cache
curl -s localhost:8081/healthz                              # web is up
curl -s localhost:8081/api/catalog/search?q=zork | head -c 200
```

### Configuration

Copy `.env.example` to `.env` and edit. The one worth setting is `USER_AGENT`:

```bash
USER_AGENT=OmniUHS/1.0 (+personal use; you@example.com)
```

It is sent to every upstream. uhs-hints.com has been dormant since ~2015 and
IFDB rejects requests without a real User-Agent, so be identifiable and
reachable. The other variables are documented in `.env.example`.

### Adding a game wiki

UHS, the IF Archive and IFDB work out of the box. Fandom and wiki.gg do not, on
purpose: they are platforms hosting hundreds of thousands of wikis about
everything, and neither offers a filter that would keep this to games. So you
name the ones you want — from the app, one tap, nothing to restart:

1. **Search** for the game.
2. Tap **Look for a wiki for "…"** under the results.
3. Each wiki that answered is listed with its real name and licence. Tap
   **Add**.

The search re-runs immediately and the wiki's pages are in it. There is no
`.env` edit and no `docker compose up -d` — the allowlist lives in the proxy's
cache database, which is on the same volume as everything else and is included
in your backups.

**When the guess misses.** Step 2 works by trying the addresses a wiki for that
name would plausibly live at, because neither platform publishes a searchable
index. It finds most games and misses the ones whose wiki is named after the
series: Zelda's is `zelda.fandom.com`, which "Tears of the Kingdom" will never
produce. When that happens, find the wiki in a browser and paste its address
into **Settings → Game wikis → Add a wiki**. A pasted address is checked
directly, so it always works.

**Settings → Game wikis** lists everything you have added, with its licence, and
removes any of them again.

Each wiki is asked about itself on first contact — its name, its API path, and
its licence — and the answer is re-checked daily. The licence is shown before
you download anything, because it decides what you can do with the result: a
`-NC` wiki (common on ex-Gamepedia game wikis such as Terraria's) marks
everything from it **personal use only**, which keeps it out of a shareable
export while leaving it in a full backup.

Wiki pages are re-shaped on the way in rather than stored as written — sections
become questions, paragraphs become hints revealed one at a time. A page that
turns out to be all infobox and stat tables is refused with a note saying so,
which is the expected outcome for a weapon or item page. Aim at the puzzle,
secret and ending pages.

**`WIKI_ALLOWLIST`** is still there, for seeding a fresh container with wikis
you always want:

```bash
WIKI_ALLOWLIST=animalwell.wiki.gg,blue-prince.fandom.com
```

Anything listed there is **pinned**: shown in Settings, but not removable from
the app, because something in the environment was put there deliberately.
Either way, only `*.fandom.com` and `*.wiki.gg` are ever accepted.

### Changing the port

`docker-compose.local.yml` publishes `127.0.0.1:8081:80` — bound to loopback, so
it is not exposed to your LAN. To reach it from another machine on the network,
change it to `8081:80`, but see the warning in §3 first.

---

## 2. Tailnet (recommended for phones)

**Needs:** a Tailscale account, and in the admin console:

- **MagicDNS** enabled — Settings → DNS
- **HTTPS Certificates** enabled — Settings → DNS → HTTPS Certificates

Then:

```bash
cp .env.example .env
```

Put a reusable, non-ephemeral auth key in it (admin console → Settings → Keys →
Generate auth key; tick *Reusable*, leave *Ephemeral* off so the node survives a
restart):

```bash
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
USER_AGENT=OmniUHS/1.0 (+personal use; you@example.com)
```

```bash
docker compose up -d --build
docker compose logs -f ts-sidecar     # watch it authenticate and get a cert
```

The app is now at `https://omni-uhs.<your-tailnet>.ts.net` from any device
signed into your tailnet. Nothing is published to the host or the LAN: the web
and proxy containers share the sidecar's network namespace and talk over
loopback, and `AllowFunnel` is off, so it is not reachable from the public
internet.

The first certificate can take a minute. If the browser shows a TLS error, check
`docker compose logs ts-sidecar` for a `getCertificate` line.

### On the phone

1. Open the `https://omni-uhs.…ts.net` URL in **Safari** (not Chrome — only
   Safari can install a PWA on iOS).
2. Share → **Add to Home Screen**.
3. Launch it from the home screen icon, not the browser.

That last step matters more than it sounds. An installed iOS web app is exempt
from Safari's 7-day eviction of unused sites' storage; a browser tab is not, so
a library read from a tab can quietly disappear after a week away.

---

## 3. Notes on exposing it

Don't. This is a personal-use hint reader that stores copyrighted hint content;
publishing it would need written permission from the Universal Hint System
first, and the app has no multi-user model, no authentication and no rate limits
of its own.

Tailscale is the recommended path precisely because it gives you remote access
without exposing anything. If you must reach it from your LAN, bind the local
stack to your LAN address and leave it there — do not port-forward it.

---

## 4. Backups

Two volumes are worth keeping:

```bash
# cache-data — downloaded hint files and catalogues. Rebuildable, but refetching
# is rude to a dormant site.
# ts-state   — the Tailscale node identity and its certificate.
docker run --rm \
  -v omni-uhs_cache-data:/from:ro \
  -v "$PWD":/to \
  alpine tar czf /to/omni-uhs-cache-$(date +%F).tar.gz -C /from .
```

Your **library** is not in either volume — it lives in the browser's IndexedDB,
on each device. **Settings → Export & import** has two ways to take a copy:

- **Full backup** — everything: every title, its original bytes, how far you
  have revealed each set of hints, and your settings. This is the one to use
  before switching phones or clearing site data. It necessarily contains
  personal-use-only material, so it asks you to confirm that first, and the
  archive carries the notice with it. Copying it between your own devices is
  personal use; putting it anywhere other people can reach is not.
- **Shareable export** — the subset with no redistribution restriction, and no
  reading progress attached. Personal-use-only titles are listed in the
  manifest rather than silently dropped.

Import restores either. Reveal progress is merged upwards, so restoring an older
backup never re-hides a hint you have already seen.

Theme and text size ride along in a full backup too. They live in
`localStorage` rather than IndexedDB — they have to be readable before the first
paint, or the app flashes the wrong theme on every launch — so they are stored
separately and restored separately.

---

## 5. The images

Two, both on GitHub Container Registry:

```
ghcr.io/marcushogue/omni-uhs-web:latest      # Caddy + the built PWA
ghcr.io/marcushogue/omni-uhs-proxy:latest    # Fastify cache/allowlist proxy
```

Both are published by `.github/workflows/publish.yml` on push to `main`, and
both are **public** — no `docker login` needed:

```bash
docker pull ghcr.io/marcushogue/omni-uhs-web:latest
docker pull ghcr.io/marcushogue/omni-uhs-proxy:latest
```

Browse them from the repository's **Packages** panel. They are `linux/amd64`
only; see the Synology notes for ARM.

Every build is tagged three ways — `latest`, the full commit SHA, and the first
seven characters of it. The short one exists because a registry matches tags as
literal strings and will not expand an abbreviated Git object id: `:1a2b3c4`
only resolves because it is published under that exact name.

Pinning by SHA is worth doing on a NAS, where the UI has no "pull" button:
changing the tag is the whole update, and it rolls back the same way. Copy a tag
from the Packages page.

```yaml
image: ghcr.io/marcushogue/omni-uhs-web:1a2b3c4
```

If you fork this and keep your own packages private, pulling needs a classic
PAT with the **`read:packages`** scope:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

---

## 6. Logs

Both containers log to stdout, so `docker logs` is the whole story. Nothing is
written to disk beyond Docker's own rotation (`10m × 3`, set in the compose
files).

```bash
docker compose logs -f                    # both, interleaved
docker compose logs -f proxy              # upstream fetches, cache, searches
docker compose logs -f web                # HTTP access log
```

**web** is a Caddy access log, one line per request. The health check is
excluded — it fires every 30 seconds and says nothing.

**proxy** is newline-delimited JSON, one object per event, tagged with a
`component`. At the default `info` level you get:

| component | what it tells you |
|---|---|
| `http` | one line per API request: method, path, status, ms, `x-cache` |
| `upstream` | every request that actually left the machine, with host and timing |
| `cache` | what got stored, what came back `304`, what was served stale |
| `catalog` | index refreshes and how many entries they produced |
| `search` | one line per search: per-source hit counts, groups, total ms |

It is dense to read raw, so pipe it through `jq`:

```bash
# Everything that left the machine today
docker compose logs --no-log-prefix proxy | jq -c 'select(.component=="upstream")'

# Searches, and how each source did
docker compose logs --no-log-prefix proxy | jq -r \
  'select(.component=="search") | "\(.query)\t\(.sources)\t\(.ms)ms"'

# Anything that went wrong
docker compose logs --no-log-prefix proxy | jq -c 'select(.level=="warn" or .level=="error")'
```

`LOG_LEVEL=debug` adds cache hits and misses — the level to use when something
is being refetched more often than it should be, or served stale when it
shouldn't. `LOG_REQUESTS=false` drops the per-request access line and keeps only
the activity events.

A search's query string appears in both logs. That is the point — it is how you
tell "the search returned nothing" from "the search never ran" — but it is worth
knowing before you paste a log into an issue.

---

## 7. Knowing when to update

Both images are stamped with the commit they were built from, and the app knows
its own. `GET /api/version` reports the proxy's; the web bundle carries its own
inside it.

- When a **new web build** is waiting, the app shows a one-line notice you can
  dismiss, and **Settings → Version** offers *Reload to update*. Nothing reloads
  itself: an app that refreshed out from under you mid-hint would be worse than
  one that waits.
- When the **proxy reports a different build**, the app says so. That usually
  means one container was pulled and the other was not — `docker compose pull`
  fetches both. If they already match on the server, the browser is holding an
  older bundle and a reload picks the new one up.

Settings always shows both versions and the current state, whether or not the
notice was dismissed. Dismissal is remembered per version, so the next release
asks again.

Images built by hand report `dev`, which switches the whole thing off rather
than comparing versions that do not mean anything.

---

## 8. Updating

Images are published to GHCR on every push to `main`:

```bash
docker compose pull && docker compose up -d          # tailnet
docker compose -f docker-compose.local.yml pull && \
  docker compose -f docker-compose.local.yml up -d   # local
```

Or rebuild from source with `--build`.

A new build reaches an already-installed PWA on the next launch: `index.html`
and the service worker are served `no-store`, so the browser always re-checks
them, while the content-hashed assets are cached for a year.

---

## 9. Troubleshooting

**The proxy container restarts in a loop.** Check `docker compose logs proxy`;
it names the cause. An `EACCES` on the cache directory means it is a **bind
mount** whose host directory the container user cannot write to — the container
runs as uid 65532, so `sudo chown -R 65532:65532 /path/on/host` fixes it. Named
volumes (what both compose files here use) never hit this: the image seeds
`/data/cache` with the right ownership and the volume inherits it.

**Search returns warnings about a source.** That is the designed behaviour: a
source that is unreachable names itself in `warnings[]` and the others still
return.

**StrategyWiki says it is behind a Cloudflare challenge.** It is, and there is
nothing to fix. `strategywiki.org` answers every server-side request with a
managed challenge — a JavaScript and browser-fingerprint test that no HTTP
client can pass, from any IP, with any User-Agent. So:

- StrategyWiki is **off by default** (`SEARCH_SOURCES`). Turn the chip on in
  Search if you want to try it.
- When it is on and the proxy is challenged, the app **retries from your
  browser**, which is the client Cloudflare is actually willing to serve. That
  often works, and when it does the warning disappears and the results merge in
  normally.
- If the browser is challenged too, every row still links out to the page.

The clearance token cannot be shared between the two: Cloudflare binds it to the
requesting IP and User-Agent, so one your phone earns is worthless to the NAS.
That is why the browser makes the request itself rather than handing something
back to the proxy.

**IFDB rows have a "View" link instead of a Download button.** IFDB is a
catalogue of interactive fiction, not a hint source — there is no file to
download. Its page usually points at the walkthrough on the IF Archive, which
*is* downloadable. For the same reason IFDB does not appear under Browse: it
publishes no index to page through.

**Downloads fail with "not allowed".** The proxy enforces a hostname allowlist
(`UPSTREAM_ALLOWLIST`). That is the SSRF boundary; add the host deliberately or
not at all.

**"wiki host not allowed".** A Fandom or wiki.gg host that has not been added —
see §1. Note the wiki allowlist is a separate list from `UPSTREAM_ALLOWLIST`: a
wiki on it is reachable only through `/api/wiki/:host`, never through the
generic fetchers.

**The Fandom or wiki.gg chip is greyed out.** No wikis have been added for that
platform, so searching it could only ever return nothing. §1 has the fix.

**"Nothing answered" when looking for a wiki.** Neither platform has a search
API, so this is guesswork from the game's name and it does miss — particularly
where the wiki is named after the series rather than the game. Find the wiki in
a browser and paste its address into Settings → Game wikis instead.

**A wiki cannot be removed.** It came from `WIKI_ALLOWLIST` and is shown as
*pinned*. Edit the environment variable and restart to change it.

**A wiki page refuses to download, saying it looks like a reference page.**
Working as intended. That page is mostly infobox and stat tables, with no
prose to turn into hints — normal for an item, weapon or character page. Puzzle,
secret, boss and ending pages are the ones that carry guidance.

**Nothing loads offline.** Confirm the service worker registered: DevTools →
Application → Service Workers. It only registers over HTTPS or on `localhost`.

**iOS keeps forgetting the library.** It was opened in a Safari tab rather than
from the Home Screen icon. See §2.

---

## 10. Synology NAS

See **[SYNOLOGY.md](SYNOLOGY.md)**.
