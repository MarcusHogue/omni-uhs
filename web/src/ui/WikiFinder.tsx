/**
 * Adding a game wiki, in one tap.
 *
 * Neither Fandom nor wiki.gg publishes an index, so the proxy finds a wiki by
 * guessing the slugs one might live at and asking each whether it is there.
 * That works for most games and fails for the rest — Zelda's wiki is
 * `zelda.fandom.com`, which no slugification of "Tears of the Kingdom" reaches
 * — so pasting the address from a browser tab is always accepted too.
 *
 * Probing happens on a tap, never on a keystroke: each attempt is real traffic
 * to someone else's server.
 */

import { useState } from 'react';

import { api, isOfflineError, type WikiCandidate } from '../api/client';
import { ErrorNote, Spinner } from './bits';

/** The licence, and what it costs you, in one line. */
export function LicenceLine({
  license,
  personalUseOnly,
}: {
  license: string;
  personalUseOnly: boolean;
}): JSX.Element {
  return (
    <span className="muted">
      {license}
      {personalUseOnly && (
        <>
          {' '}
          <span className="pill" title="Kept out of a shareable export; still in a full backup.">
            personal use only
          </span>
        </>
      )}
    </span>
  );
}

export function WikiFinder({
  query,
  showInput = false,
  onAdded,
}: {
  /** A query to offer, e.g. what the user just searched for. */
  query?: string;
  /** Show a box of its own, for Settings where there is no search to borrow. */
  showInput?: boolean;
  onAdded?: (host: string) => void;
}): JSX.Element | null {
  const [typed, setTyped] = useState('');
  const [candidates, setCandidates] = useState<WikiCandidate[] | null>(null);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const term = (showInput ? typed : (query ?? '')).trim();

  const find = async (): Promise<void> => {
    if (term.length < 2) return;
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const result = await api.discoverWikis(term);
      setCandidates(result.candidates);
      setSearched(term);
    } catch (caught) {
      setError(
        isOfflineError(caught)
          ? 'Finding a wiki needs a connection.'
          : (caught as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const add = async (host: string): Promise<void> => {
    setAdding(host);
    setError(null);
    try {
      await api.allowWiki(host);
      setCandidates((current) =>
        (current ?? []).map((row) => (row.host === host ? { ...row, allowed: true } : row)),
      );
      onAdded?.(host);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setAdding(null);
    }
  };

  if (!showInput && term.length < 2) return null;

  return (
    <div className="wiki-finder">
      {showInput && (
        <input
          className="filter"
          type="search"
          value={typed}
          placeholder="Game name, or paste a wiki address…"
          aria-label="Find a game wiki"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void find();
          }}
        />
      )}

      <button type="button" className="chip" disabled={busy || term.length < 2} onClick={() => void find()}>
        {busy ? 'Looking…' : `Look for a wiki for “${term || '…'}”`}
      </button>

      {busy && <Spinner label="Asking Fandom and wiki.gg…" />}
      {error && <ErrorNote error={error} />}

      {candidates?.length === 0 && (
        <p className="muted">
          Nothing answered for “{searched}”. Neither platform has a search API, so this is
          guesswork from the name — if you can find the wiki in a browser, paste its address
          here and it will be checked directly.
        </p>
      )}

      {candidates && candidates.length > 0 && (
        <ul className="list">
          {candidates.map((candidate) => (
            <li className="row" key={candidate.host}>
              <div className="row-main">
                <span className="row-title">{candidate.sitename}</span>
                <span className="row-meta">
                  <span className="muted mono">{candidate.host}</span>
                  {candidate.gamepedia && (
                    <span className="pill" title="Was a Gamepedia wiki, so it is about a game.">
                      game wiki
                    </span>
                  )}
                </span>
                <LicenceLine
                  license={candidate.license}
                  personalUseOnly={candidate.personalUseOnly}
                />
              </div>
              <button
                type="button"
                className="row-action"
                disabled={candidate.allowed || adding === candidate.host}
                onClick={() => void add(candidate.host)}
              >
                {candidate.allowed ? 'Added' : adding === candidate.host ? 'Adding…' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
