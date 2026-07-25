import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { HintGroupNode, ImageNode, Inline, Node, TextNode } from '../parser/ast';
import {
  getDocument,
  getRevealState,
  setRevealed,
  clearRevealState,
  type StoredDocument,
} from '../storage/db';
import { SourceBadge, Spinner } from './bits';
import { buildIndex, displayChildren, pathTo, searchLabels, unwrap } from './tree';

export function Reader(): JSX.Element {
  const { id, nodeId } = useParams<{ id: string; nodeId?: string }>();
  const navigate = useNavigate();
  const [stored, setStored] = useState<StoredDocument | null>(null);
  const [missing, setMissing] = useState(false);
  const [revealed, setRevealedState] = useState<Record<string, number>>({});
  const [find, setFind] = useState('');

  const documentId = id ? decodeURIComponent(id) : '';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await getDocument(documentId);
      if (cancelled) return;
      if (!found) {
        setMissing(true);
        return;
      }
      setStored(found);
      const state = await getRevealState(documentId);
      if (!cancelled) setRevealedState(state.revealed);
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const index = useMemo(() => (stored ? buildIndex(stored.document) : null), [stored]);

  const reveal = useCallback(
    (groupId: string, count: number) => {
      setRevealedState((current) => ({ ...current, [groupId]: count }));
      void setRevealed(documentId, groupId, count);
    },
    [documentId],
  );

  if (missing) {
    return (
      <div className="empty">
        <h2>Not in your library</h2>
        <p>
          This title is not downloaded. <Link to="/">Back to the library</Link>.
        </p>
      </div>
    );
  }
  if (!stored || !index) return <Spinner label="Opening…" />;

  const currentId = nodeId ? decodeURIComponent(nodeId) : (stored.document.root.id ?? '');
  const current = unwrap(index.byId.get(currentId) ?? stored.document.root);
  const trail = pathTo(index, currentId);
  const matches = searchLabels(index, find);

  const go = (target: string): void =>
    navigate(`/read/${encodeURIComponent(documentId)}/${encodeURIComponent(target)}`);

  return (
    <div className="reader">
      <div className="reader-head">
        <p className="crumbs">
          <Link to="/">Library</Link>
          {trail.map((node, i) => (
            <span key={node.id ?? i}>
              {' › '}
              {i === trail.length - 1 ? (
                <strong>{node.label}</strong>
              ) : (
                <button type="button" className="linkish" onClick={() => go(node.id!)}>
                  {node.label}
                </button>
              )}
            </span>
          ))}
        </p>
        <p className="row-meta">
          <SourceBadge kind={stored.sourceKind} />
          <span className="muted">{stored.attribution ?? stored.license}</span>
        </p>
      </div>

      <input
        className="filter"
        type="search"
        value={find}
        placeholder="Find a section or question…"
        onChange={(event) => setFind(event.target.value)}
        aria-label="Find in this document"
      />
      {find.trim().length >= 2 && (
        <div className="find-results">
          <p className="muted">
            {matches.length} match{matches.length === 1 ? '' : 'es'} in section and question
            titles. Hint text is never searched, so nothing here can spoil you.
          </p>
          <ul className="list">
            {matches.map((match) => (
              <li key={match.id} className="row">
                <button
                  type="button"
                  className="row-main linkish"
                  onClick={() => {
                    setFind('');
                    go(match.id);
                  }}
                >
                  <span className="row-title">{match.label}</span>
                  <span className="muted">{match.path.slice(1).join(' › ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {find.trim().length < 2 && (
        <NodeView
          node={current}
          revealed={revealed}
          onReveal={reveal}
          onNavigate={go}
          onResetReveals={() => {
            void clearRevealState(documentId).then(() => setRevealedState({}));
          }}
        />
      )}
    </div>
  );
}

interface ViewProps {
  node: Node;
  revealed: Record<string, number>;
  onReveal: (groupId: string, count: number) => void;
  onNavigate: (id: string) => void;
  onResetReveals: () => void;
}

function NodeView(props: ViewProps): JSX.Element {
  const { node } = props;
  switch (node.type) {
    case 'subject':
      return <SubjectView {...props} />;
    case 'hints':
      return <HintsView {...props} group={node} />;
    case 'text':
      return <TextView node={node} />;
    case 'image':
      return <ImageView node={node} onNavigate={props.onNavigate} />;
    case 'link':
      return (
        <p>
          <button
            type="button"
            className="linkish"
            onClick={() => node.targetId && props.onNavigate(node.targetId)}
          >
            {node.label} →
          </button>
        </p>
      );
  }
}

function SubjectView({ node, revealed, onNavigate }: ViewProps): JSX.Element {
  const children = displayChildren(node);
  if (children.length === 0) return <p className="muted">Nothing here.</p>;

  return (
    <ul className="list">
      {children.map((child, position) => {
        const target = child.type === 'link' ? child.targetId : child.id;
        const seen = child.type === 'hints' ? (revealed[child.id ?? ''] ?? 0) : 0;
        return (
          <li key={child.id ?? position} className="row" data-type={child.type}>
            <button
              type="button"
              className="row-main linkish"
              disabled={!target}
              onClick={() => target && onNavigate(target)}
            >
              <span className="row-title">
                <TypeMark type={child.type} /> {child.label || '(untitled)'}
              </span>
              {child.type === 'hints' && (
                <span className="muted">
                  {child.hints.length} hint{child.hints.length === 1 ? '' : 's'}
                  {seen > 0 && ` · ${seen} revealed`}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TypeMark({ type }: { type: Node['type'] }): JSX.Element {
  const marks: Record<Node['type'], string> = {
    subject: '▸',
    hints: '?',
    text: '≡',
    image: '▣',
    link: '→',
  };
  return (
    <span className="typemark" aria-hidden="true">
      {marks[type]}
    </span>
  );
}

/**
 * The spoiler-critical view.
 *
 * `hints[i]` is only rendered once `hints[i-1]` has been revealed by an
 * explicit tap. Unrevealed hints are not rendered hidden — they are not
 * rendered at all, so no CSS slip, screen reader, or find-in-page can leak
 * them.
 */
function HintsView({
  group,
  revealed,
  onReveal,
  onNavigate,
}: ViewProps & { group: HintGroupNode }): JSX.Element {
  const id = group.id ?? '';
  const shown = Math.min(revealed[id] ?? 0, group.hints.length);
  const remaining = group.hints.length - shown;

  return (
    <div className="hints">
      <h2 className="question">{group.label}</h2>

      <ol className="hint-list">
        {group.hints.slice(0, shown).map((hint, i) => (
          <li key={hint.id ?? i} className="hint">
            <span className="hint-number">{i + 1}</span>
            <div className="hint-body">
              <InlineRuns content={hint.content} />
              {hint.nested && hint.nested.length > 0 && (
                <ul className="list nested">
                  {hint.nested.map(unwrap).map((nested, n) => (
                    <li key={nested.id ?? n} className="row">
                      <button
                        type="button"
                        className="row-main linkish"
                        onClick={() => {
                          const target = nested.type === 'link' ? nested.targetId : nested.id;
                          if (target) onNavigate(target);
                        }}
                      >
                        <TypeMark type={nested.type} /> {nested.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>

      {remaining > 0 ? (
        <button type="button" className="reveal" onClick={() => onReveal(id, shown + 1)}>
          {shown === 0 ? 'Show the first hint' : 'Show the next hint'}
          <span className="muted"> · {remaining} remaining</span>
        </button>
      ) : (
        <p className="muted">
          That is every hint for this question.
          {shown > 0 && (
            <>
              {' '}
              <button type="button" className="linkish" onClick={() => onReveal(id, 0)}>
                Hide them again
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function TextView({ node }: { node: TextNode }): JSX.Element {
  return (
    <div className="textnode">
      <h2>{node.label}</h2>
      <InlineRuns content={node.content} />
    </div>
  );
}

function ImageView({
  node,
  onNavigate,
}: {
  node: ImageNode;
  onNavigate: (id: string) => void;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    // A blob URL keeps the bytes out of the DOM as base64 and is revoked on
    // unmount so the memory goes back.
    const blob = new Blob([node.data as BlobPart], { type: node.mime });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    setNatural(null);
    return () => URL.revokeObjectURL(objectUrl);
  }, [node]);

  const hotspots = node.hotspots ?? [];

  return (
    <div className="imagenode">
      <h2>{node.label}</h2>

      <div className="image-frame">
        {url && (
          <img
            src={url}
            alt={node.label}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        )}
        {/*
          Hotspot rectangles are in the image's own pixel space, so they are
          converted to percentages once the natural size is known. That keeps
          them aligned however the image is scaled to the phone's width.
        */}
        {natural &&
          natural.width > 0 &&
          hotspots.map((hotspot, i) => {
            const [x1, y1, x2, y2] = hotspot.rect;
            const style = {
              left: `${(Math.min(x1, x2) / natural.width) * 100}%`,
              top: `${(Math.min(y1, y2) / natural.height) * 100}%`,
              width: `${(Math.abs(x2 - x1) / natural.width) * 100}%`,
              height: `${(Math.abs(y2 - y1) / natural.height) * 100}%`,
            };
            return (
              <button
                key={i}
                type="button"
                className="hotspot"
                style={style}
                aria-label={hotspot.target.label}
                title={hotspot.target.label}
                onClick={() => hotspot.target.targetId && onNavigate(hotspot.target.targetId)}
              />
            );
          })}
      </div>

      {hotspots.length > 0 && (
        <>
          {/* The same targets as a list: reachable by keyboard, and usable when
              a rectangle is too small to tap accurately on a phone. */}
          <p className="muted">Tappable areas of this image:</p>
          <ul className="list">
            {hotspots.map((hotspot, i) => (
              <li key={i} className="row">
                <button
                  type="button"
                  className="row-main linkish"
                  onClick={() => hotspot.target.targetId && onNavigate(hotspot.target.targetId)}
                >
                  <TypeMark type="link" /> {hotspot.target.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function InlineRuns({ content }: { content: Inline[] }): JSX.Element {
  return (
    <p className="runs">
      {content.map((item, i) =>
        item.kind === 'run' ? (
          <span key={i} className={item.mono ? 'mono' : undefined}>
            {item.text}
          </span>
        ) : (
          <span key={i} className="inline-link">
            {item.label}
          </span>
        ),
      )}
    </p>
  );
}
