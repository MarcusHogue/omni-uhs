import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  api,
  isOfflineError,
  strategyWikiSearchUrl,
  type CatalogEntry,
  type SourceInfo,
  type WikiSite,
} from '../api/client';
import { getSetting } from '../storage/db';
import { downloadEntry } from '../storage/download';
import { ErrorNote, SourceBadge, Spinner, Warnings } from './bits';
import { useLatest, useLibrary, useOfflineRefs } from './hooks';
import { refUrl } from './refs';

const LETTERS = '#abcdefghijklmnopqrstuvwxyz'.split('');

/** The sources that are a *platform* of many wikis rather than one site. */
const WIKI_PLATFORMS = ['fandom', 'wikigg'] as const;
type WikiPlatform = (typeof WIKI_PLATFORMS)[number];

const isWikiPlatform = (source: string): source is WikiPlatform =>
  (WIKI_PLATFORMS as readonly string[]).includes(source);

const PLATFORM_LABELS: Record<WikiPlatform, string> = {
  fandom: 'Fandom',
  wikigg: 'wiki.gg',
};

/**
 * What the server says exists. `null` until it answers.
 *
 * Unlike search, browse cannot fall back to a hard-coded list: which wikis are
 * reachable is entirely a deployment decision (`WIKI_ALLOWLIST`), and guessing
 * would offer links that 400.
 */
function useSources(): SourceInfo[] | null {
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .sources()
      .then((response) => {
        if (!cancelled) setSources(response.sources);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return sources;
}

const hostsOf = (sources: SourceInfo[] | null, kind: WikiPlatform): string[] =>
  sources?.find((source) => source.kind === kind)?.hosts ?? [];

/** Per-source drill-down, for when you would rather look than search. */
export function Browse(): JSX.Element {
  const { source } = useParams<{ source?: string }>();
  if (!source) return <SourcePicker />;
  return <SourceListing source={source} />;
}

function SourcePicker(): JSX.Element {
  const sources = useSources();
  const platforms = WIKI_PLATFORMS.map((kind) => ({ kind, hosts: hostsOf(sources, kind) })).filter(
    (platform) => platform.hosts.length > 0,
  );

  return (
    <div className="empty">
      <h2>Browse a source</h2>
      <ul className="list">
        <li className="row">
          <Link className="row-main" to="/browse/uhs">
            <span className="row-title">Universal Hint System</span>
            <span className="muted">A–Z index of every UHS hint file</span>
          </Link>
        </li>
        <li className="row">
          <Link className="row-main" to="/browse/ifarchive">
            <span className="row-title">IF Archive</span>
            <span className="muted">Solutions, hints and InvisiClues</span>
          </Link>
        </li>
        <li className="row">
          <Link className="row-main" to="/browse/strategywiki">
            <span className="row-title">StrategyWiki</span>
            <span className="muted">Pages under a game prefix (CC-BY-SA 4.0)</span>
          </Link>
        </li>
        {platforms.map(({ kind, hosts }) => (
          <li className="row" key={kind}>
            <Link className="row-main" to={`/browse/${kind}`}>
              <span className="row-title">{PLATFORM_LABELS[kind]}</span>
              <span className="muted">
                {hosts.length === 1
                  ? hosts[0]
                  : `${hosts.length} wikis: ${hosts.slice(0, 3).join(', ')}${
                      hosts.length > 3 ? '…' : ''
                    }`}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {sources !== null && platforms.length === 0 && (
        <p className="muted">
          Fandom and wiki.gg host wikis for almost every game, and for a great many things
          that are not games, so nothing from either is listed until you add the ones you
          want. Search for a game and use &ldquo;Look for a wiki&rdquo;, or add one under{' '}
          <Link to="/settings">Settings</Link>.
        </p>
      )}

      {/* Asked often enough to be worth answering here: IFDB is missing on
          purpose, not by oversight. */}
      <p className="muted">
        IFDB is search-only. It is a catalogue of interactive fiction rather than a hint
        source — there is nothing to download from it, and it publishes no index to page
        through. Its search results link out to the game&rsquo;s IFDB page, which usually
        points at the walkthrough on the IF Archive.
      </p>
    </div>
  );
}

function SourceListing({ source }: { source: string }): JSX.Element {
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [challengeLink, setChallengeLink] = useState<string | null>(null);
  const runLatest = useLatest();
  const { documents, reload } = useLibrary();
  const offlineRefs = useOfflineRefs(documents);

  // StrategyWiki has no browsable index worth paging through; it needs a prefix.
  const needsPrefix = source === 'strategywiki';

  // A wiki platform names hundreds of independent sites, so browsing one means
  // picking a wiki first. The choice lives in the URL rather than in state, so a
  // listing stays linkable and the back button works.
  const platform = isWikiPlatform(source) ? source : null;
  const sources = useSources();
  const hosts = platform ? hostsOf(sources, platform) : [];
  const [params, setParams] = useSearchParams();
  const host = platform ? (params.get('host') ?? hosts[0] ?? null) : null;
  // Nothing can be listed until we know which wiki; `sources === null` is
  // still-loading, which is not the same as "none allowlisted".
  const waitingForHost = platform !== null && host === null;

  useEffect(() => {
    if (needsPrefix && prefix.trim() === '') {
      setEntries([]);
      return;
    }
    if (waitingForHost) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    setChallengeLink(null);
    runLatest(async (signal) => {
      try {
        const response = await api.list(source, prefix, signal, host ?? undefined);
        setEntries(response.entries);
        setWarnings(response.warnings);

        // The proxy was bot-challenged. Try the same listing from the browser,
        // which the upstream is far more willing to serve.
        if (response.challenged?.includes('strategywiki')) {
          try {
            const direct = await api.listStrategyWikiDirect(prefix, signal);
            setEntries(direct);
            setWarnings([]);
          } catch (caught) {
            // Challenged here too, and there are no rows to link out from, so
            // offer the site's own search — a navigation is the only request a
            // person can actually pass a bot check on.
            if ((caught as Error).name !== 'AbortError') {
              setChallengeLink(strategyWikiSearchUrl(prefix));
            }
          }
        }
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setEntries([]);
        setError(
          isOfflineError(caught)
            ? 'Browsing needs a connection. Your downloaded titles are still available.'
            : (caught as Error).message,
        );
      } finally {
        setLoading(false);
      }
    });
  }, [source, prefix, needsPrefix, host, waitingForHost, runLatest]);

  return (
    <>
      <p className="crumbs">
        <Link to="/browse">Browse</Link> › <SourceBadge kind={source as never} />
        {host && <> › <span className="mono">{host}</span></>}
      </p>

      {platform && (
        <WikiHeader
          hosts={hosts}
          host={host}
          loaded={sources !== null}
          onPick={(next) => {
            setPrefix('');
            setParams({ host: next });
          }}
        />
      )}

      {source === 'uhs' && (
        <div className="chips">
          <button
            type="button"
            className={prefix === '' ? 'chip chip-on' : 'chip'}
            onClick={() => setPrefix('')}
          >
            All
          </button>
          {LETTERS.map((letter) => (
            <button
              key={letter}
              type="button"
              className={prefix === letter ? 'chip chip-on' : 'chip'}
              onClick={() => setPrefix(letter)}
            >
              {letter.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {(source === 'ifarchive' || needsPrefix || (platform && host)) && (
        <input
          className="filter"
          type="search"
          value={prefix}
          placeholder={
            needsPrefix
              ? 'Game page prefix, e.g. "Chrono Trigger/"'
              : platform
                ? 'Page title starts with… (leave blank for the first 200)'
                : 'Filter by path…'
          }
          onChange={(event) => setPrefix(event.target.value)}
          aria-label="Filter listing"
        />
      )}

      {loading && <Spinner label="Loading listing…" />}
      {error && <ErrorNote error={error} />}
      <Warnings warnings={warnings} />
      {challengeLink && (
        <p className="muted">
          <a className="link-out" href={challengeLink} target="_blank" rel="noreferrer noopener">
            Search StrategyWiki directly ↗
          </a>{' '}
          — opening the site yourself is the one request its bot check will let you
          through.
        </p>
      )}

      <ul className="list">
        {entries.map((entry) => (
          <BrowseRow
            key={`${entry.sourceKind}:${entry.host ?? ''}:${entry.ref}`}
            entry={entry}
            downloaded={offlineRefs.has(entry.ref) || offlineRefs.has(refUrl(entry))}
            onDownloaded={reload}
          />
        ))}
      </ul>

      {!loading && !error && entries.length === 0 && !waitingForHost && (
        <p className="muted">
          {needsPrefix && prefix.trim() === ''
            ? 'Type a game name to list its pages.'
            : 'Nothing here.'}
        </p>
      )}
    </>
  );
}

/**
 * Which wiki, and on what terms.
 *
 * The licence is shown *before* anything is downloaded because it decides what
 * can be done with the result afterwards: a `-NC` wiki marks everything it
 * yields personal-use-only, which keeps it out of a shareable export. Finding
 * that out after the fact would be a nasty surprise.
 */
function WikiHeader({
  hosts,
  host,
  loaded,
  onPick,
}: {
  hosts: string[];
  host: string | null;
  loaded: boolean;
  onPick: (host: string) => void;
}): JSX.Element {
  const [site, setSite] = useState<WikiSite | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);

  useEffect(() => {
    setSite(null);
    setSiteError(null);
    if (!host) return;
    let cancelled = false;
    api
      .wikiSite(host)
      .then((result) => {
        if (!cancelled) setSite(result);
      })
      .catch((caught: Error) => {
        if (!cancelled) setSiteError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host) {
    return (
      <p className="muted">
        {loaded ? (
          <>
            No wikis have been added for this platform yet.{' '}
            <Link to="/settings">Add one in Settings</Link> and it is browsable straight
            away.
          </>
        ) : (
          'Loading wikis…'
        )}
      </p>
    );
  }

  return (
    <>
      {hosts.length > 1 && (
        <div className="chips" role="group" aria-label="Choose a wiki">
          {hosts.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={candidate === host ? 'chip chip-on' : 'chip'}
              aria-pressed={candidate === host}
              onClick={() => onPick(candidate)}
            >
              {candidate.replace(/\.(fandom\.com|wiki\.gg)$/, '')}
            </button>
          ))}
        </div>
      )}
      <p className="muted">
        {site ? (
          <>
            {site.sitename} — {site.license}
            {site.personalUseOnly && (
              <>
                {' '}
                <span className="pill">personal use only</span>
              </>
            )}
          </>
        ) : siteError ? (
          `Could not read this wiki's licence: ${siteError}`
        ) : (
          'Checking licence…'
        )}
      </p>
    </>
  );
}

function BrowseRow({
  entry,
  downloaded,
  onDownloaded,
}: {
  entry: CatalogEntry;
  downloaded: boolean;
  onDownloaded: () => void;
}): JSX.Element {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // On a wiki the ref *is* the title, so printing both is the same word twice.
  const ref = entry.ref.replace(/^https?:\/\//, '');

  return (
    <li className="row">
      <div className="row-main">
        <span className="row-title">{entry.title}</span>
        <span className="row-meta">
          {ref !== entry.title && <span className="muted mono">{ref}</span>}
          {downloaded && <span className="pill pill-offline">Available offline</span>}
        </span>
        {error && <span className="error">{error}</span>}
      </div>
      <button
        type="button"
        className="row-action"
        disabled={working}
        onClick={() => {
          setWorking(true);
          setError(null);
          void (async () => {
            try {
              const decodeIncentive = await getSetting('decodeIncentive', false);
              const { stored } = await downloadEntry(entry, { decodeIncentive });
              onDownloaded();
              navigate(`/read/${encodeURIComponent(stored.id)}`);
            } catch (caught) {
              setError((caught as Error).message);
            } finally {
              setWorking(false);
            }
          })();
        }}
      >
        {working ? 'Downloading…' : downloaded ? 'Re-download' : 'Download'}
      </button>
    </li>
  );
}
