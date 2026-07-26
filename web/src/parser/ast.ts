/**
 * The common AST — the contract between every source, the renderer, the storage
 * layer, and (later) the Swift re-implementation.
 *
 * This file, and everything under `src/parser/`, must remain free of DOM,
 * React and Node dependencies. Pure data in, pure data out.
 *
 * Everything here is JSON-serializable with one exception: `ImageNode.data` is a
 * `Uint8Array`, which IndexedDB's structured clone handles natively. The
 * export/import path base64-encodes it explicitly.
 */

export type SourceKind =
  | 'uhs'
  | 'strategywiki'
  | 'fandom'
  | 'wikigg'
  | 'ifarchive'
  | 'ifdb';

export interface DocumentSource {
  kind: SourceKind;
  /** Canonical origin URL. */
  url: string;
  /** Wiki revision ID or file date, when the source exposes one. */
  revision?: string;
  /** e.g. "CC-BY-SA-4.0", "proprietary-personal-use". */
  license: string;
  /** Required display text for CC-BY-SA content. */
  attribution?: string;
  /** true => excluded from export/share, forever. */
  personalUseOnly: boolean;
}

export interface HintDocument {
  /** Stable hash of source kind + ref. */
  id: string;
  game: { title: string; sourceTitle?: string };
  source: DocumentSource;
  /** ISO timestamp. */
  fetchedAt: string;
  root: SubjectNode;
}

/**
 * Additive extension to the spec's node types: every container node carries a
 * deterministic `id`.
 *
 * Two things need it. `LinkNode.targetId` has to point at something, and
 * reveal-state persistence needs a key that survives re-downloading a title.
 * For UHS the id is derived from the hunk's line number (`uhs:214`), which is
 * exactly what the format's own `link` hunks reference; for tree-shaped sources
 * it is the path (`p:0.2.1`).
 */
export interface NodeBase {
  id?: string;
}

export type Node =
  | SubjectNode
  | HintGroupNode
  | TextNode
  | ImageNode
  | LinkNode;

export interface SubjectNode extends NodeBase {
  type: 'subject';
  label: string;
  children: Node[];
}

export interface HintGroupNode extends NodeBase {
  type: 'hints';
  /** The question. */
  label: string;
  /** Revealed strictly one at a time. */
  hints: HintNode[];
  /**
   * Advisory only, set by the wiki parser.
   *
   * A wiki page is not written to be a hint, and only some of it is. This says
   * which the section looks like so the reader can lead with the useful part —
   * it never removes anything, because the signal cannot see a deduction game's
   * answers at all. See `parser/wikitext/guidance.ts`.
   *
   * Absent is the common case and means "no opinion", not "reference".
   * `reference` is only ever set from the heading, never from a low score.
   */
  role?: 'guidance' | 'reference';
}

export interface HintNode extends NodeBase {
  type: 'hint';
  content: Inline[];
  /** From `nesthint` '=' sections. */
  nested?: SubjectNode[];
  /**
   * Pictures that belong to this step, from the wiki sources.
   *
   * Attached to the hint and not to the subject on purpose: on games like Blue
   * Prince the picture *is* the answer — a scan of an in-game document — so it
   * must not be rendered until the hint above it has been revealed by a tap.
   */
  images?: ImageNode[];
}

export interface TextNode extends NodeBase {
  type: 'text';
  label: string;
  content: Inline[];
  /**
   * Pictures the section referred to.
   *
   * Mirrors `HintNode.images`, and for the same reason: a StrategyWiki page
   * reads as written, so its prose becomes a `text` node rather than a hint —
   * and without this the pictures on it were parsed, then quietly dropped on
   * the floor. Nothing hides them behind a reveal here, because nothing on such
   * a page is hidden in the first place.
   */
  images?: ImageNode[];
}

export interface Hotspot {
  rect: [number, number, number, number];
  target: LinkNode;
}

/**
 * Where a wiki picture came from, and what happened to it.
 *
 * Kept alongside the bytes rather than inside them so a document can say
 * honestly that it *has* a picture it did not download — a caption and a link
 * out beat a silent gap when the caption is "Solution to the Antechamber door".
 */
export interface ImageSource {
  /** The wiki's own file title, e.g. `Antechamber puzzle.png`. Unique per wiki. */
  file: string;
  /** Page to view the original on. */
  url?: string;
  width?: number;
  height?: number;
  /** Set when the bytes were deliberately not stored. */
  omitted?: 'decorative' | 'budget' | 'unavailable';
}

export interface ImageNode extends NodeBase {
  type: 'image';
  label: string;
  /**
   * The bytes, or empty for a wiki picture whose bytes live in the `images`
   * store under `blobKey` — 11 MB of Blue Prince scans inside the document
   * would be read back on every visit to the Library.
   *
   * Renderers must check `data.length`: `new Blob([new Uint8Array()])` draws a
   * broken-image icon.
   */
  data: Uint8Array;
  mime: string;
  hotspots?: Hotspot[];
  /** Key into the `images` store. Unset for UHS, where the bytes are inline. */
  blobKey?: string;
  /** Unset for UHS. */
  source?: ImageSource;
}

export interface LinkNode extends NodeBase {
  type: 'link';
  label: string;
  /** Id of the target node, or '' when the target could not be resolved. */
  targetId: string;
}

export type Inline =
  | { kind: 'run'; text: string; mono?: boolean }
  | { kind: 'link'; label: string; targetId: string };

/**
 * Parsers never throw on malformed-but-recoverable input; they record a warning
 * and carry on. CRC mismatches, unknown hunk types and unparseable locators all
 * land here. `warnings` deliberately lives outside `HintDocument` so the stored
 * document matches the spec's shape exactly.
 */
export interface ParseResult {
  document: HintDocument;
  warnings: string[];
}

/** Convenience guards — used by the renderer and the in-document search. */
export function isSubject(n: Node): n is SubjectNode {
  return n.type === 'subject';
}
export function isHintGroup(n: Node): n is HintGroupNode {
  return n.type === 'hints';
}
export function isText(n: Node): n is TextNode {
  return n.type === 'text';
}
export function isImage(n: Node): n is ImageNode {
  return n.type === 'image';
}
export function isLink(n: Node): n is LinkNode {
  return n.type === 'link';
}

/** Depth-first walk over every node in a document. */
export function* walk(node: Node): Generator<Node> {
  yield node;
  if (node.type === 'subject') {
    for (const child of node.children) yield* walk(child);
  } else if (node.type === 'hints') {
    for (const hint of node.hints) {
      for (const nested of hint.nested ?? []) yield* walk(nested);
      for (const image of hint.images ?? []) yield* walk(image);
    }
  } else if (node.type === 'text') {
    for (const image of node.images ?? []) yield* walk(image);
  } else if (node.type === 'image') {
    for (const hotspot of node.hotspots ?? []) yield* walk(hotspot.target);
  }
}

/** Plain text of an inline run sequence. Used for search and export. */
export function inlineText(content: Inline[]): string {
  return content.map((i) => (i.kind === 'run' ? i.text : i.label)).join('');
}
