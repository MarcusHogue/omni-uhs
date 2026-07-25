import type { SourceKind } from '../parser/ast';

export const SOURCE_LABELS: Record<SourceKind, string> = {
  uhs: 'UHS',
  ifarchive: 'IF Archive',
  ifdb: 'IFDB',
  strategywiki: 'StrategyWiki',
  fandom: 'Fandom',
  wikigg: 'wiki.gg',
};

export function SourceBadge({ kind }: { kind: SourceKind }): JSX.Element {
  return <span className={`badge badge-${kind}`}>{SOURCE_LABELS[kind] ?? kind}</span>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

export function ErrorNote({ error }: { error: string }): JSX.Element {
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

/** Sources that report a failure still let the rest of a search through. */
export function Warnings({ warnings }: { warnings: string[] }): JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <div className="warnings-box" role="status">
      <strong>Some sources did not answer:</strong>
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}
