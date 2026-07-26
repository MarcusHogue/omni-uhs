import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  api,
  isOfflineError,
  type CatalogEntry,
  strategyWikiPageUrl,
  strategyWikiSearchUrl,
  type CatalogGroup,
  type SourceInfo,
} from '../api/client';
import type { SourceKind } from '../parser/ast';
import { downloadEntry } from '../storage/download';
import { getSetting } from '../storage/db';
import { ErrorNote, SOURCE_LABELS, SourceBadge, Spinner, Warnings } from './bits';
import { useDebounced, useLatest, useLibrary, useOfflineRefs, useOnline } from './hooks';
import { refUrl, wikiPageUrl } from './refs';
import { WikiFinder } from './WikiFinder';

/**
 * Chips to show before `/api/catalog/sources` answers — and if it never does.
 *
 * The server is the authority on which sources are on by default (SEARCH_SOURCES),
 * but the first keystroke should not have to wait for a round-trip, so this
 * mirrors the shipped default.
 */
const FALLBACK_SOURCES: SourceInfo[] = [
  { kind: 'uhs', enabledByDefault: true },
  { kind: 'ifarchive', enabledByDefault: true },
  { kind: 'ifdb', enabledByDefault: true },
  { kind: 'strategywiki', enabledByDefault: false },
];

const MIN_QUERY = 3;
const DEBOUNCE_MS = 400;

const defaultsOf = (sources: SourceInfo[]): SourceKind[] =>
  sources.filter((source) => source.enabledByDefault).map((source) => source.kind);

/**
 * A wiki platform with nothing in `WIKI_ALLOWLIST` can only ever return
 * nothing — it is hundreds of sites and the server has been given none of them.
 * The chip stays visible so the feature is discoverable, but switching it on
 * would be a lie, so it is disabled and says why.
 */
const unconfigured = (source: SourceInfo): boolean =>
  (source.kind === 'fandom' || source.kind === 'wikigg') && (source.hosts?.length ?? 0) === 0;

export function Search(): JSX.Element {
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<SourceInfo[]>(FALLBACK_SOURCES);
  const [selected, setSelected] = useState<SourceKind[]>(() => defaultsOf(FALLBACK_SOURCES));
  /** Once the user has touched a chip, the server's defaults stop overriding it. */
  const touchedChips = useRef(false);
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /**
   * Set when neither the proxy nor this browser could reach StrategyWiki.
   *
   * At that point there are no StrategyWiki rows to link out from, so without
   * this the user gets a paragraph of explanation and no way forward. A
   * navigation is the one request Cloudflare will issue a solvable challenge
   * for, so hand them one.
   */
  const [challengeLink, setChallengeLink] = useState<string | null>(null);
  /**
   * Bumped when a wiki is added, to re-run both the source list and the search.
   * Adding one is only useful if the results you were already looking at pick
   * it up without being retyped.
   */
  const [wikisAdded, setWikisAdded] = useState(0);

  const debounced = useDebounced(query, DEBOUNCE_MS);
  const runLatest = useLatest();
  const online = useOnline();
  const { documents, reload } = useLibrary();
  const offlineRefs = useOfflineRefs(documents);

  // Only surface a caveat for a source the user has switched *on* against the
  // server's advice — otherwise every search carries a paragraph of small print.
  const selectedNotes = sources
    .filter((source) => selected.includes(source.kind) && !source.enabledByDefault && source.note)
    .map((source) => `${SOURCE_LABELS[source.kind]}: ${source.note!}`);

  // Ask the server which sources it has and which it considers default. A
  // failure here is not worth surfacing: the fallback list is already correct
  // for a stock deployment, and a real outage will show up on the search itself.
  // Re-runs after a wiki is added, which changes both the hosts and whether the
  // platform chips are usable at all.
  useEffect(() => {
    let cancelled = false;
    api
      .sources()
      .then((response) => {
        if (cancelled || response.sources.length === 0) return;
        setSources(response.sources);
        if (!touchedChips.current) setSelected(defaultsOf(response.sources));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wikisAdded]);

  useEffect(() => {
    const trimmed = debounced.trim();
    // An empty selection must mean "nothing", not "fall back to the defaults" —
    // which is what sending no `sources` parameter would do.
    if (trimmed.length < MIN_QUERY || selected.length === 0) {
      setGroups([]);
      setWarnings([]);
      setError(null);
      setChallengeLink(null);
      return;
    }
    setSearching(true);
    setError(null);
    setChallengeLink(null);
    runLatest(async (signal) => {
      try {
        const response = await api.search(trimmed, selected, signal);
        setGroups(response.groups);
        setWarnings(response.warnings);

        // A source that bot-challenged the server may still answer the browser.
        // Retry those here and fold the results in, dropping the warning if it
        // works — the user does not need to hear about a failure we recovered.
        if (response.challenged?.includes('strategywiki')) {
          try {
            const direct = await api.searchStrategyWikiDirect(trimmed, signal);
            if (direct.length > 0) {
              setGroups((current) => mergeEntries(current, direct));
              setWarnings((current) => current.filter((w) => !w.startsWith('strategywiki:')));
            }
          } catch (caught) {
            // Challenged here too: no rows, so nothing to link out from. Offer
            // the site's own search page — opening it is a navigation, which is
            // the only kind of request a person can pass a challenge on.
            if ((caught as Error).name !== 'AbortError') {
              setChallengeLink(strategyWikiSearchUrl(trimmed));
            }
          }
        }
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setGroups([]);
        setError(
          isOfflineError(caught)
            ? 'Search needs a connection. Everything already downloaded is still readable in your library.'
            : (caught as Error).message,
        );
      } finally {
        setSearching(false);
      }
    });
  }, [debounced, selected, wikisAdded, runLatest]);

  return (
    <>
      <input
        className="filter"
        type="search"
        value={query}
        placeholder="Search every source…"
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search for a game"
        autoComplete="off"
      />

      <div className="chips" role="group" aria-label="Filter by source">
        {sources.map((source) => {
          const active = selected.includes(source.kind);
          const disabled = unconfigured(source);
          const title = disabled
            ? `No ${SOURCE_LABELS[source.kind]} wikis have been added yet. Search for a game and use “Look for a wiki”.`
            : source.note;
          return (
            <button
              key={source.kind}
              type="button"
              className={active ? 'chip chip-on' : 'chip'}
              aria-pressed={active}
              disabled={disabled}
              {...(title ? { title } : {})}
              onClick={() => {
                touchedChips.current = true;
                setSelected((current) =>
                  current.includes(source.kind)
                    ? current.filter((s) => s !== source.kind)
                    : [...current, source.kind],
                );
              }}
            >
              <SourceBadge kind={source.kind} />
            </button>
          );
        })}
      </div>

      {selectedNotes.map((note) => (
        <p key={note} className="muted">
          {note}
        </p>
      ))}

      {!online && (
        <p className="muted">
          You are offline. Search needs a connection; your library does not.
        </p>
      )}
      {query.trim().length > 0 && query.trim().length < MIN_QUERY && (
        <p className="muted">Type at least {MIN_QUERY} characters.</p>
      )}
      {selected.length === 0 && <p className="muted">Pick at least one source.</p>}
      {searching && <Spinner label="Searching…" />}
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
        {groups.map((group) => (
          <li key={group.normalizedTitle} className="group">
            <h3>{group.title}</h3>
            <ul className="sublist">
              {group.entries.map((entry) => (
                <ResultRow
                  key={`${entry.sourceKind}:${entry.ref}`}
                  entry={entry}
                  downloaded={offlineRefs.has(entry.ref) || offlineRefs.has(refUrl(entry))}
                  onDownloaded={reload}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {!searching &&
        !error &&
        selected.length > 0 &&
        debounced.trim().length >= MIN_QUERY &&
        groups.length === 0 && (
          <p className="muted">Nothing found for “{debounced.trim()}”.</p>
        )}

      {/* A game with no hint file may still have a wiki. Offered after the
          results rather than instead of them: this costs real requests to
          Fandom and wiki.gg, so it happens when asked and not before. */}
      {!searching && debounced.trim().length >= MIN_QUERY && (
        <WikiFinder
          query={debounced.trim()}
          onAdded={() => setWikisAdded((n) => n + 1)}
        />
      )}
    </>
  );
}

/**
 * Fold client-side results into the server's grouping.
 *
 * The server did the ranking, so its order is preserved: an entry whose title
 * already has a group joins it, and anything new is appended rather than
 * interleaved — a source we had to rescue by hand has not earned a top slot.
 */
function mergeEntries(groups: CatalogGroup[], extra: CatalogEntry[]): CatalogGroup[] {
  const merged = groups.map((group) => ({ ...group, entries: [...group.entries] }));
  const byTitle = new Map(merged.map((group) => [group.normalizedTitle, group]));

  for (const entry of extra) {
    const existing = byTitle.get(entry.normalizedTitle);
    if (existing) {
      const already = existing.entries.some(
        (e) => e.sourceKind === entry.sourceKind && e.ref === entry.ref,
      );
      if (!already) existing.entries.push(entry);
      continue;
    }
    const group: CatalogGroup = {
      normalizedTitle: entry.normalizedTitle,
      title: entry.title,
      entries: [entry],
    };
    byTitle.set(group.normalizedTitle, group);
    merged.push(group);
  }
  return merged;
}

/**
 * What distinguishes one entry from another *within* a group.
 *
 * The group heading already carries the title, so repeating it tells the user
 * nothing — and a game often has several IF Archive files (an InvisiClues
 * transcript, a step-by-step solution, a plain walkthrough), which would
 * otherwise be four identical-looking rows.
 */
function describe(entry: CatalogEntry): string {
  const parts: string[] = [];
  if (entry.sourceKind === 'ifarchive') {
    parts.push(entry.ref.split('/').pop() ?? entry.ref);
  } else if (entry.sourceKind === 'strategywiki') {
    parts.push(entry.ref);
  } else if (entry.host) {
    // A wiki row is the whole game, so the wiki's address is the useful
    // distinguishing detail — there is no page to name.
    parts.push(entry.host);
  } else {
    parts.push(entry.title);
  }
  if (entry.meta?.year) parts.push(String(entry.meta.year));
  if (entry.meta?.date) parts.push(entry.meta.date);
  if (entry.meta?.size) parts.push(`${Math.max(1, Math.round(entry.meta.size / 1024))} KB`);
  return parts.join(' · ');
}

/**
 * The page this entry describes, on the source's own site.
 *
 * IFDB has no hint file to download — it is an index of interactive fiction, so
 * the useful action is "go and look", not a button that cannot work. Same for a
 * StrategyWiki page the proxy could not reach.
 */
function externalUrl(entry: CatalogEntry): string | null {
  if (entry.sourceKind === 'ifdb') return `https://ifdb.org/viewgame?id=${entry.ref}`;
  if (entry.sourceKind === 'strategywiki') return strategyWikiPageUrl(entry.ref);
  if (entry.host) return wikiPageUrl(entry.host, entry.ref);
  return null;
}

function ResultRow({
  entry,
  downloaded,
  onDownloaded,
}: {
  entry: CatalogEntry;
  downloaded: boolean;
  onDownloaded: () => void;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>(
    downloaded ? 'done' : 'idle',
  );
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const navigate = useNavigate();
  const external = externalUrl(entry);

  const download = async (): Promise<void> => {
    setState('working');
    setMessage(null);
    setProgress(null);
    try {
      const decodeIncentive = await getSetting('decodeIncentive', false);
      const { stored, warnings } = await downloadEntry(entry, {
        decodeIncentive,
        // A wiki game fetches sixty pages and then a few hundred pictures, two
        // at a time, behind one button. Without this it reads as a hang.
        onProgress: (phase, done, total) =>
          setProgress(`${phase === 'pages' ? 'Pages' : 'Images'} ${done}/${total}`),
      });
      setState('done');
      setProgress(null);
      if (warnings.length > 0) setMessage(`${warnings.length} parser note(s)`);
      onDownloaded();
      navigate(`/read/${encodeURIComponent(stored.id)}`);
    } catch (error) {
      setState('error');
      setProgress(null);
      setMessage((error as Error).message);
    }
  };

  return (
    <li className="row">
      <div className="row-main">
        <span className="row-meta">
          <SourceBadge kind={entry.sourceKind} />
          <span className="muted">{describe(entry)}</span>
          {downloaded && <span className="pill pill-offline">Available offline</span>}
        </span>
        {progress && (
          <span className="muted" role="status">
            {progress}
          </span>
        )}
        {message && <span className={state === 'error' ? 'error' : 'muted'}>{message}</span>}
        {state === 'error' && external && (
          <a className="link-out" href={external} target="_blank" rel="noreferrer noopener">
            Open on {SOURCE_LABELS[entry.sourceKind]} ↗
          </a>
        )}
      </div>
      {entry.sourceKind === 'ifdb' ? (
        <a
          className="row-action"
          href={external ?? 'https://ifdb.org/'}
          target="_blank"
          rel="noreferrer noopener"
          title="IFDB is a catalogue of interactive fiction — there is no hint file to download. Its entry usually links to the walkthroughs that are on the IF Archive."
        >
          View ↗
        </a>
      ) : (
        <button
          type="button"
          className="row-action"
          disabled={state === 'working'}
          onClick={() => void download()}
        >
          {state === 'working' ? 'Downloading…' : downloaded ? 'Re-download' : 'Download'}
        </button>
      )}
    </li>
  );
}
