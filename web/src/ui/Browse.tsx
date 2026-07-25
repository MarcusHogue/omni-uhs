import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, isOfflineError, type CatalogEntry } from '../api/client';
import { getSetting } from '../storage/db';
import { downloadEntry } from '../storage/download';
import { ErrorNote, SourceBadge, Spinner, Warnings } from './bits';
import { useLatest, useLibrary, useOfflineRefs } from './hooks';

const LETTERS = '#abcdefghijklmnopqrstuvwxyz'.split('');

/** Per-source drill-down, for when you would rather look than search. */
export function Browse(): JSX.Element {
  const { source } = useParams<{ source?: string }>();
  if (!source) return <SourcePicker />;
  return <SourceListing source={source} />;
}

function SourcePicker(): JSX.Element {
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
      </ul>
    </div>
  );
}

function SourceListing({ source }: { source: string }): JSX.Element {
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const runLatest = useLatest();
  const { documents, reload } = useLibrary();
  const offlineRefs = useOfflineRefs(documents);

  // StrategyWiki has no browsable index worth paging through; it needs a prefix.
  const needsPrefix = source === 'strategywiki';

  useEffect(() => {
    if (needsPrefix && prefix.trim() === '') {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    runLatest(async (signal) => {
      try {
        const response = await api.list(source, prefix, signal);
        setEntries(response.entries);
        setWarnings(response.warnings);
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
  }, [source, prefix, needsPrefix, runLatest]);

  return (
    <>
      <p className="crumbs">
        <Link to="/browse">Browse</Link> › <SourceBadge kind={source as never} />
      </p>

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

      {(source === 'ifarchive' || needsPrefix) && (
        <input
          className="filter"
          type="search"
          value={prefix}
          placeholder={
            needsPrefix ? 'Game page prefix, e.g. "Chrono Trigger/"' : 'Filter by path…'
          }
          onChange={(event) => setPrefix(event.target.value)}
          aria-label="Filter listing"
        />
      )}

      {loading && <Spinner label="Loading listing…" />}
      {error && <ErrorNote error={error} />}
      <Warnings warnings={warnings} />

      <ul className="list">
        {entries.map((entry) => (
          <BrowseRow
            key={`${entry.sourceKind}:${entry.ref}`}
            entry={entry}
            downloaded={offlineRefs.has(entry.ref)}
            onDownloaded={reload}
          />
        ))}
      </ul>

      {!loading && !error && entries.length === 0 && (
        <p className="muted">
          {needsPrefix && prefix.trim() === ''
            ? 'Type a game name to list its pages.'
            : 'Nothing here.'}
        </p>
      )}
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

  return (
    <li className="row">
      <div className="row-main">
        <span className="row-title">{entry.title}</span>
        <span className="row-meta">
          <span className="muted mono">{entry.ref.replace(/^https?:\/\//, '')}</span>
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
