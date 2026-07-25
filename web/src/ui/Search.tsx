import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, isOfflineError, type CatalogEntry, type CatalogGroup } from '../api/client';
import type { SourceKind } from '../parser/ast';
import { downloadEntry } from '../storage/download';
import { getSetting } from '../storage/db';
import { ErrorNote, SourceBadge, Spinner, Warnings } from './bits';
import { useDebounced, useLatest, useLibrary, useOfflineRefs, useOnline } from './hooks';

const SOURCES: SourceKind[] = ['uhs', 'ifarchive', 'strategywiki', 'ifdb'];
const MIN_QUERY = 3;
const DEBOUNCE_MS = 400;

export function Search(): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SourceKind[]>(SOURCES);
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const debounced = useDebounced(query, DEBOUNCE_MS);
  const runLatest = useLatest();
  const online = useOnline();
  const { documents, reload } = useLibrary();
  const offlineRefs = useOfflineRefs(documents);

  useEffect(() => {
    const trimmed = debounced.trim();
    if (trimmed.length < MIN_QUERY) {
      setGroups([]);
      setWarnings([]);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    runLatest(async (signal) => {
      try {
        const response = await api.search(trimmed, selected, signal);
        setGroups(response.groups);
        setWarnings(response.warnings);
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
  }, [debounced, selected, runLatest]);

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
        {SOURCES.map((source) => {
          const active = selected.includes(source);
          return (
            <button
              key={source}
              type="button"
              className={active ? 'chip chip-on' : 'chip'}
              aria-pressed={active}
              onClick={() =>
                setSelected((current) =>
                  current.includes(source)
                    ? current.filter((s) => s !== source)
                    : [...current, source],
                )
              }
            >
              <SourceBadge kind={source} />
            </button>
          );
        })}
      </div>

      {!online && (
        <p className="muted">
          You are offline. Search needs a connection; your library does not.
        </p>
      )}
      {query.trim().length > 0 && query.trim().length < MIN_QUERY && (
        <p className="muted">Type at least {MIN_QUERY} characters.</p>
      )}
      {searching && <Spinner label="Searching…" />}
      {error && <ErrorNote error={error} />}
      <Warnings warnings={warnings} />

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

      {!searching && !error && debounced.trim().length >= MIN_QUERY && groups.length === 0 && (
        <p className="muted">Nothing found for “{debounced.trim()}”.</p>
      )}
    </>
  );
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
  } else {
    parts.push(entry.title);
  }
  if (entry.meta?.year) parts.push(String(entry.meta.year));
  if (entry.meta?.date) parts.push(entry.meta.date);
  if (entry.meta?.size) parts.push(`${Math.max(1, Math.round(entry.meta.size / 1024))} KB`);
  return parts.join(' · ');
}

/** The URL form a stored document records, so downloads can be matched. */
function refUrl(entry: CatalogEntry): string {
  if (entry.sourceKind === 'ifarchive') {
    return `https://ifarchive.org/${entry.ref.replace(/^\/+/, '')}`;
  }
  if (entry.sourceKind === 'strategywiki') {
    return `https://strategywiki.org/wiki/${encodeURIComponent(
      entry.ref.split('/')[0]!.replace(/ /g, '_'),
    )}`;
  }
  return entry.ref;
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
  const navigate = useNavigate();

  const download = async (): Promise<void> => {
    setState('working');
    setMessage(null);
    try {
      const decodeIncentive = await getSetting('decodeIncentive', false);
      const { stored, warnings } = await downloadEntry(entry, { decodeIncentive });
      setState('done');
      if (warnings.length > 0) setMessage(`${warnings.length} parser note(s)`);
      onDownloaded();
      navigate(`/read/${encodeURIComponent(stored.id)}`);
    } catch (error) {
      setState('error');
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
        {message && <span className={state === 'error' ? 'error' : 'muted'}>{message}</span>}
      </div>
      <button
        type="button"
        className="row-action"
        disabled={state === 'working' || entry.sourceKind === 'ifdb'}
        title={
          entry.sourceKind === 'ifdb'
            ? 'IFDB is a catalogue only — download this game from UHS or the IF Archive'
            : undefined
        }
        onClick={() => void download()}
      >
        {state === 'working' ? 'Downloading…' : downloaded ? 'Re-download' : 'Download'}
      </button>
    </li>
  );
}
