import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { deleteDocument } from '../storage/db';
import { SourceBadge, formatBytes } from './bits';
import { useLibrary } from './hooks';

/**
 * The library: everything downloaded, filterable as you type.
 *
 * The filter runs entirely against IndexedDB, so it works in airplane mode —
 * that is the point of the screen, not an optimisation.
 */
export function Library(): JSX.Element {
  const { documents, loading, reload } = useLibrary();
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((d) => d.title.toLowerCase().includes(needle));
  }, [documents, filter]);

  const total = documents.reduce((sum, d) => sum + d.size, 0);

  if (loading) return <p className="muted">Loading your library…</p>;

  if (documents.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing downloaded yet</h2>
        <p>
          Use <Link to="/search">Search</Link> to find a game, or{' '}
          <Link to="/browse">Browse</Link> a source. Once downloaded, a title is readable
          with no network at all.
        </p>
      </div>
    );
  }

  return (
    <>
      <input
        className="filter"
        type="search"
        value={filter}
        placeholder={`Filter ${documents.length} title${documents.length === 1 ? '' : 's'}…`}
        onChange={(event) => setFilter(event.target.value)}
        aria-label="Filter library"
      />

      <ul className="list">
        {shown.map((document) => (
          <li key={document.id} className="row">
            <Link className="row-main" to={`/read/${encodeURIComponent(document.id)}`}>
              <span className="row-title">{document.title}</span>
              <span className="row-meta">
                <SourceBadge kind={document.sourceKind} />
                <span className="pill pill-offline">Available offline</span>
                <span className="muted">{formatBytes(document.size)}</span>
              </span>
              {document.attribution && (
                <span className="attribution">{document.attribution}</span>
              )}
              {!document.attribution && (
                <span className="attribution muted">{document.license}</span>
              )}
              {document.warnings.length > 0 && (
                <span className="warnings">
                  {document.warnings.length} parser note
                  {document.warnings.length === 1 ? '' : 's'}
                </span>
              )}
            </Link>
            <button
              type="button"
              className="row-action danger"
              aria-label={`Delete ${document.title}`}
              onClick={() => {
                if (!confirm(`Delete "${document.title}" and its reveal history?`)) return;
                void deleteDocument(document.id).then(reload);
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {shown.length === 0 && <p className="muted">No title matches “{filter}”.</p>}

      <p className="muted footnote">
        {documents.length} title{documents.length === 1 ? '' : 's'} · {formatBytes(total)} stored
      </p>
    </>
  );
}
