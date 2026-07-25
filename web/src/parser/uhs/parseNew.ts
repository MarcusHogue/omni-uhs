/**
 * The 91a/95a/96a section.
 *
 * After the `** END OF 88A FORMAT **` marker, line numbering restarts at 1 and
 * the file becomes a tree of hunks. A hunk header reads `<N> <type>` where N
 * counts the header line itself, so an unknown type is always skippable by
 * advancing N lines — that forward-compatibility rule is load-bearing and is
 * applied to malformed known hunks too.
 *
 * Line numbers are preserved rather than consumed: line N (1-based) is always
 * `lines[N - 1]`, so a hunk's identity is its header line and a `link`
 * destination resolves by direct lookup. (The reference implementation splices
 * lines out of the array as it goes and compensates with offset arithmetic;
 * not doing that removes a whole class of off-by-two bugs.)
 */

import type {
  HintGroupNode,
  HintNode,
  Hotspot,
  ImageNode,
  Inline,
  LinkNode,
  Node,
  SubjectNode,
  TextNode,
} from '../ast.js';
import { decode88, decodeKey, makeKey } from './cipher.js';
import { asciiDecode, bytesEqualAscii, cp437Decode } from './cp437.js';
import type { UhsContainer } from './lines.js';
import { tokenizeBlock } from './markup.js';

export interface ParseNewOptions {
  /**
   * Registration-gated `incentive` hunks stay encrypted unless the user turns
   * this on in Settings (spec §11).
   */
  decodeIncentive?: boolean;
}

interface Context {
  container: UhsContainer;
  /** New-format lines only. Line number N is `lines[N - 1]`. */
  lines: Uint8Array[];
  key: Uint8Array;
  warnings: string[];
  decodeIncentive: boolean;
  definedIds: Set<string>;
  pendingLinks: LinkNode[];
}

const HEADER_RE = /^(\d+) ([a-z][a-z0-9]*)$/;

const nodeId = (line1Based: number): string => `uhs:${line1Based}`;

function text(line: Uint8Array | undefined): string {
  return line ? asciiDecode(line) : '';
}

/** Trailing integers of a locator line, e.g. "0 0 1234 56" -> [1234, 56]. */
function lastTwoInts(line: Uint8Array | undefined): [number, number] | null {
  const parts = text(line).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const a = Number.parseInt(parts[parts.length - 2]!, 10);
  const b = Number.parseInt(parts[parts.length - 1]!, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function parseInts(line: Uint8Array | undefined, count: number): number[] | null {
  const parts = text(line).trim().split(/\s+/).filter(Boolean);
  if (parts.length !== count) return null;
  const out: number[] = [];
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    if (!Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

/** Split a byte blob into CR-stripped lines, as the text section is split. */
function blobLines(blob: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  const current: number[] = [];
  for (let i = 0; i < blob.length; i++) {
    const b = blob[i]!;
    if (b === 0x0d) continue;
    if (b === 0x0a) {
      lines.push(Uint8Array.from(current));
      current.length = 0;
      continue;
    }
    current.push(b);
  }
  if (current.length > 0) lines.push(Uint8Array.from(current));
  return lines;
}

function isSeparator(line: Uint8Array | undefined, ch: string): boolean {
  return line !== undefined && bytesEqualAscii(line, ch);
}

/** A hint's inline content is only ever built from already-decrypted lines. */
function hintContent(decoded: string[]): Inline[] {
  return tokenizeBlock(decoded);
}

/**
 * Nested hunks inside a `nesthint` are typed `SubjectNode[]` by the AST. Real
 * files nest links and hint groups there too, so anything that is not already a
 * subject gets a one-child subject wrapper rather than being dropped.
 */
function asSubject(node: Node): SubjectNode {
  if (node.type === 'subject') return node;
  const wrapper: SubjectNode = { type: 'subject', label: node.label, children: [node] };
  if (node.id) wrapper.id = `${node.id}:w`;
  return wrapper;
}

interface HunkRun {
  nodes: Node[];
  /** Index of the first line after the run. */
  next: number;
}

/**
 * Parse a run of sibling hunks in `[start, end)`.
 *
 * Stops at the first line that is not a well-formed hunk header, which is how
 * `nesthint` knows where its nested block ends.
 */
function parseHunks(start: number, end: number, ctx: Context): HunkRun {
  const nodes: Node[] = [];
  let i = start;
  while (i < end) {
    const header = HEADER_RE.exec(text(ctx.lines[i]));
    if (!header) break;
    const size = Number.parseInt(header[1]!, 10);
    const type = header[2]!;
    if (!Number.isFinite(size) || size < 1) break;
    parseHunk(type, i, Math.min(i + size, end), ctx, nodes);
    i += size;
  }
  return { nodes, next: i };
}

/** Parse a single hunk, appending it (and any siblings it spawns) to `out`. */
function parseHunk(
  type: string,
  start: number,
  end: number,
  ctx: Context,
  out: Node[],
): void {
  const id = nodeId(start + 1);
  const label = cp437Decode(ctx.lines[start + 1] ?? new Uint8Array());
  const bodyStart = start + 2;

  switch (type) {
    case 'subject': {
      const node: SubjectNode = {
        id,
        type: 'subject',
        label,
        children: parseHunks(bodyStart, end, ctx).nodes,
      };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'link': {
      const destination = Number.parseInt(text(ctx.lines[bodyStart]).trim(), 10);
      const node: LinkNode = {
        id,
        type: 'link',
        label,
        targetId: Number.isFinite(destination) ? nodeId(destination) : '',
      };
      if (!Number.isFinite(destination)) {
        ctx.warnings.push(`link hunk at line ${start + 1} has no destination.`);
      } else {
        ctx.pendingLinks.push(node);
      }
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'hint': {
      const hints: HintNode[] = [];
      let buffer: string[] = [];
      let hintStart = bodyStart;
      const flush = (): void => {
        if (buffer.length === 0 && hints.length > 0) return;
        hints.push({
          id: nodeId(hintStart + 1),
          type: 'hint',
          content: hintContent(buffer),
        });
        buffer = [];
      };
      for (let i = bodyStart; i < end; i++) {
        if (isSeparator(ctx.lines[i], '-')) {
          flush();
          hintStart = i + 1;
          continue;
        }
        buffer.push(cp437Decode(decode88(ctx.lines[i]!)));
      }
      flush();
      const node: HintGroupNode = { id, type: 'hints', label, hints };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'nesthint': {
      const hints: HintNode[] = [];
      let buffer: string[] = [];
      let nested: SubjectNode[] = [];
      let hintStart = bodyStart;
      const flush = (): void => {
        if (buffer.length === 0 && nested.length === 0 && hints.length > 0) return;
        const hint: HintNode = {
          id: nodeId(hintStart + 1),
          type: 'hint',
          content: hintContent(buffer),
        };
        if (nested.length > 0) hint.nested = nested;
        hints.push(hint);
        buffer = [];
        nested = [];
      };
      let i = bodyStart;
      while (i < end) {
        const line = ctx.lines[i]!;
        if (isSeparator(line, '-')) {
          flush();
          i += 1;
          hintStart = i;
          continue;
        }
        if (isSeparator(line, '=')) {
          // Nested hunks run until the first line that is not a hunk header.
          const run = parseHunks(i + 1, end, ctx);
          nested.push(...run.nodes.map(asSubject));
          i = run.next > i ? run.next : i + 1;
          continue;
        }
        buffer.push(cp437Decode(decodeKey(line, ctx.key, 1)));
        i += 1;
      }
      flush();
      const node: HintGroupNode = { id, type: 'hints', label, hints };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'text': {
      const locator = lastTwoInts(ctx.lines[bodyStart]);
      if (!locator) {
        ctx.warnings.push(`text hunk at line ${start + 1} has an unreadable locator.`);
        return;
      }
      const [offset, length] = locator;
      const blob = sliceRaw(ctx, offset, length, `text hunk at line ${start + 1}`);
      if (!blob) return;
      const decoded = blobLines(blob).map((l) => cp437Decode(decodeKey(l, ctx.key, 2)));
      const node: TextNode = {
        id,
        type: 'text',
        label,
        content: tokenizeBlock(decoded),
      };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'hyperpng':
    case 'gifa': {
      const locator = lastTwoInts(ctx.lines[bodyStart]);
      if (!locator) {
        ctx.warnings.push(`${type} hunk at line ${start + 1} has an unreadable locator.`);
        return;
      }
      const [offset, length] = locator;
      const data = sliceRaw(ctx, offset, length, `${type} hunk at line ${start + 1}`);
      if (!data) return;
      const node: ImageNode = {
        id,
        type: 'image',
        label,
        data,
        mime: type === 'gifa' ? 'image/gif' : 'image/png',
      };
      const hotspots = parseHotspots(bodyStart + 1, end, ctx, out);
      if (hotspots.length > 0) node.hotspots = hotspots;
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'incentive': {
      // Real files use "-" as the label line here, which is not a title.
      const node: TextNode = {
        id,
        type: 'text',
        label: label && label !== '-' ? label : 'Registration-gated hints',
        content: ctx.decodeIncentive
          ? tokenizeBlock(
              ctx.lines
                .slice(bodyStart, end)
                .map((l) => cp437Decode(decodeKey(l, ctx.key, 1))),
            )
          : [
              {
                kind: 'run',
                text:
                  'This file marks some hints as available only to registered users. ' +
                  'Enable "Show registration-gated hints" in Settings to decode them.',
              },
            ],
      };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'version':
    case 'info':
    case 'credit':
    case 'comment': {
      // These are never encrypted. `version` carries its payload on the label
      // line; `info` is a `key=value` list (plus `>`-prefixed free notes).
      const body = ctx.lines.slice(bodyStart, end).map((l) => cp437Decode(l));
      let heading: string;
      let lines: string[];
      if (type === 'version') {
        heading = 'Version';
        lines = [label, ...body];
      } else if (type === 'info') {
        heading = 'File information';
        lines = body.map(formatInfoLine);
      } else {
        heading = label || type;
        lines = body;
      }
      const node: TextNode = {
        id,
        type: 'text',
        label: heading,
        content: tokenizeBlock(lines.filter((l, index) => l !== '' || index > 0)),
      };
      ctx.definedIds.add(id);
      out.push(node);
      return;
    }

    case 'blank':
      // A menu separator. Nothing to render.
      return;

    case 'sound':
      ctx.warnings.push(`sound hunk at line ${start + 1} skipped (audio is not supported).`);
      return;

    default:
      ctx.warnings.push(
        `Unknown hunk type "${type}" at line ${start + 1}; skipped ${end - start} lines.`,
      );
      return;
  }
}

/** `x1 y1 x2 y2` followed by a hunk, repeated. */
function parseHotspots(
  start: number,
  end: number,
  ctx: Context,
  siblings: Node[],
): Hotspot[] {
  const hotspots: Hotspot[] = [];
  let i = start;
  while (i < end) {
    const rect = parseInts(ctx.lines[i], 4);
    if (!rect) break;
    const header = HEADER_RE.exec(text(ctx.lines[i + 1]));
    if (!header) break;
    const size = Number.parseInt(header[1]!, 10);
    if (!Number.isFinite(size) || size < 1) break;

    const target: Node[] = [];
    parseHunk(header[2]!, i + 1, Math.min(i + 1 + size, end), ctx, target);
    const node = target[0];
    if (node) {
      if (node.type === 'link') {
        hotspots.push({
          rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!],
          target: node,
        });
      } else {
        // Not a plain link (an inline hint group, say). Keep the node reachable
        // as a sibling and point the hotspot at it.
        siblings.push(node);
        hotspots.push({
          rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!],
          target: {
            type: 'link',
            label: 'label' in node ? node.label : '',
            targetId: node.id ?? '',
          },
        });
      }
      target.slice(1).forEach((extra) => siblings.push(extra));
    }
    i += 1 + size;
  }
  return hotspots;
}

function sliceRaw(
  ctx: Context,
  offset: number,
  length: number,
  what: string,
): Uint8Array | null {
  const { raw } = ctx.container;
  if (offset < 0 || length < 0 || offset + length > raw.length) {
    ctx.warnings.push(
      `${what} points outside the file (offset ${offset}, length ${length}); skipped.`,
    );
    return null;
  }
  return raw.slice(offset, offset + length);
}

const INFO_LABELS: Record<string, string> = {
  length: 'Length',
  date: 'Date',
  time: 'Time',
  author: 'Author',
  publisher: 'Publisher',
  copyright: 'Copyright',
  'copyright-note': 'Copyright note',
  'author-note': 'Author note',
  'game-note': 'Game note',
};

function formatInfoLine(line: string): string {
  if (line.startsWith('>')) return line.slice(1);
  const eq = line.indexOf('=');
  if (eq <= 0) return line;
  const key = line.slice(0, eq);
  const value = line.slice(eq + 1);
  return `${INFO_LABELS[key] ?? key}: ${value}`;
}

export interface ParsedNew {
  root: SubjectNode;
  /** The label the cipher key was derived from — the game title. */
  keySeed: string;
  key: Uint8Array;
}

/**
 * Parse the new-format section. `container.end88Index` must be >= 0.
 */
export function parseNew(
  container: UhsContainer,
  warnings: string[],
  options: ParseNewOptions = {},
): ParsedNew | null {
  const lines = container.lines.slice(container.end88Index + 1);
  if (lines.length < 2) {
    warnings.push('New-format section is empty.');
    return null;
  }

  // The cipher key is seeded from the label of the first top-level hunk, which
  // is the root subject's label and therefore the game title.
  const seedBytes = lines[1] ?? new Uint8Array();
  const key = makeKey(seedBytes);
  const keySeed = cp437Decode(seedBytes);

  const ctx: Context = {
    container,
    lines,
    key,
    warnings,
    decodeIncentive: options.decodeIncentive ?? false,
    definedIds: new Set<string>(),
    pendingLinks: [],
  };

  const top = parseHunks(0, lines.length, ctx).nodes;
  if (top.length === 0) {
    warnings.push('New-format section contained no readable hunks.');
    return null;
  }

  // Resolve link destinations now that every id exists.
  for (const link of ctx.pendingLinks) {
    if (!ctx.definedIds.has(link.targetId)) {
      warnings.push(`link "${link.label}" points at ${link.targetId}, which does not exist.`);
      link.targetId = '';
    }
  }

  const first = top[0]!;
  const root: SubjectNode =
    top.length === 1 && first.type === 'subject'
      ? first
      : { id: 'uhs:0', type: 'subject', label: keySeed, children: top };

  return { root, keySeed, key };
}
