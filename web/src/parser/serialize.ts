/**
 * JSON round-tripping for documents.
 *
 * `ImageNode.data` is the only non-JSON value in the AST. IndexedDB stores it
 * natively via structured clone, but fixtures and the library export need a
 * text form, so images become `{ ..., data: "base64:…" }` on the way out.
 *
 * base64 is implemented here rather than borrowed from `btoa`/`Buffer` to keep
 * the parser directory free of DOM and Node dependencies.
 */

import type { HintDocument, ImageNode, Node, SubjectNode } from './ast.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | ALPHABET.indexOf(clean[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const DATA_PREFIX = 'base64:';

type SerializedNode = Omit<Node, 'data'> & { data?: string };

/**
 * Pictures hang off three node types now, and every one of them has to be
 * walked.
 *
 * `hint.images` was already being skipped: `JSON.stringify` turns a `Uint8Array`
 * into `{}`, so an exported picture came back with no `data` and no way to tell
 * it apart from one that never had any. It went unnoticed because a wiki
 * picture's bytes live in the `images` store and the node's own `data` is empty
 * — but a UHS picture's are not, and `text.images` has just joined the list.
 */
const serializeImages = (images: ImageNode[] | undefined): unknown[] | undefined =>
  images?.map(serializeNode);

function serializeNode(node: Node): unknown {
  if (node.type === 'image') {
    const { data, ...rest } = node;
    return { ...rest, data: `${DATA_PREFIX}${toBase64(data)}` } satisfies SerializedNode;
  }
  if (node.type === 'subject') {
    return { ...node, children: node.children.map(serializeNode) };
  }
  if (node.type === 'text') {
    return node.images ? { ...node, images: serializeImages(node.images) } : node;
  }
  if (node.type === 'hints') {
    return {
      ...node,
      hints: node.hints.map((hint) => ({
        ...hint,
        ...(hint.nested ? { nested: hint.nested.map(serializeNode) } : {}),
        ...(hint.images ? { images: serializeImages(hint.images) } : {}),
      })),
    };
  }
  return node;
}

function deserializeNode(value: unknown): Node {
  const node = value as Record<string, unknown>;
  if (node['type'] === 'image') {
    const raw = node['data'];
    const data =
      typeof raw === 'string' && raw.startsWith(DATA_PREFIX)
        ? fromBase64(raw.slice(DATA_PREFIX.length))
        : new Uint8Array();
    return { ...(node as unknown as ImageNode), data };
  }
  if (node['type'] === 'subject') {
    return {
      ...(node as unknown as SubjectNode),
      children: (node['children'] as unknown[]).map(deserializeNode),
    };
  }
  if (node['type'] === 'text') {
    if (!node['images']) return node as unknown as Node;
    return { ...node, images: (node['images'] as unknown[]).map(deserializeNode) } as unknown as Node;
  }
  if (node['type'] === 'hints') {
    const hints = (node['hints'] as Record<string, unknown>[]).map((hint) => ({
      ...hint,
      ...(hint['nested'] ? { nested: (hint['nested'] as unknown[]).map(deserializeNode) } : {}),
      ...(hint['images'] ? { images: (hint['images'] as unknown[]).map(deserializeNode) } : {}),
    }));
    return { ...node, hints } as unknown as Node;
  }
  return node as unknown as Node;
}

/** JSON-safe form of a document (images become base64 strings). */
export function serializeDocument(document: HintDocument): unknown {
  return { ...document, root: serializeNode(document.root) };
}

export function deserializeDocument(value: unknown): HintDocument {
  const raw = value as Record<string, unknown>;
  return {
    ...(raw as unknown as HintDocument),
    root: deserializeNode(raw['root']) as SubjectNode,
  };
}
