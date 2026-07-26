/**
 * Navigation helpers over a `HintDocument`.
 *
 * Two things matter here. First, every node needs a resolvable id so links and
 * reveal state work. Second — the one that must never regress — the search
 * index contains labels only. A hint body that has not been revealed is never
 * put anywhere the user (or the browser's find-in-page) can reach it.
 */

import type { HintDocument, Node, SubjectNode } from '../parser/ast';
import { tableText } from '../parser/wikitext/tables';

export interface TreeIndex {
  byId: Map<string, Node>;
  parentOf: Map<string, string>;
  /** Labels only — never hint bodies. */
  searchable: { id: string; label: string; type: Node['type']; path: string[] }[];
}

function labelOf(node: Node): string {
  return node.label;
}

export function buildIndex(document: HintDocument): TreeIndex {
  const byId = new Map<string, Node>();
  const parentOf = new Map<string, string>();
  const searchable: TreeIndex['searchable'] = [];

  const visit = (node: Node, parent: string | null, path: string[]): void => {
    const id = node.id;
    if (id) {
      byId.set(id, node);
      if (parent) parentOf.set(id, parent);
      // Subjects, questions and text headings are searchable; hint bodies and
      // image payloads are not.
      searchable.push({ id, label: labelOf(node), type: node.type, path });
      // A table is the exception, because its heading says nothing: "Inns" will
      // not find "Medina", and on a reference page the cells are the only
      // content there is. Each row is indexed under the table's own id, so a hit
      // navigates to the table.
      if (node.type === 'table') {
        for (const row of node.rows) {
          const label = tableText({ headers: [], rows: [row] })
            .filter(Boolean)
            .join(' · ');
          if (label) searchable.push({ id, label, type: node.type, path });
        }
      }
    }

    const childPath = [...path, labelOf(node)];
    if (node.type === 'subject') {
      for (const child of node.children) visit(child, id ?? parent, childPath);
    } else if (node.type === 'hints') {
      for (const hint of node.hints) {
        for (const nested of hint.nested ?? []) visit(nested, id ?? parent, childPath);
      }
    } else if (node.type === 'image') {
      for (const hotspot of node.hotspots ?? []) {
        if (hotspot.target.id) parentOf.set(hotspot.target.id, id ?? parent ?? '');
      }
    }
  };

  visit(document.root, null, []);
  return { byId, parentOf, searchable };
}

/**
 * Collapse the synthetic wrappers the UHS parser adds around non-subject hunks
 * nested inside a `nesthint`.
 *
 * The AST types require `HintNode.nested` to be `SubjectNode[]`, so a nested
 * link is wrapped in a one-child subject carrying the same label. Showing both
 * would make the user tap twice to reach the same thing.
 */
export function unwrap(node: Node): Node {
  if (
    node.type === 'subject' &&
    node.children.length === 1 &&
    (node.id?.endsWith(':w') ?? false)
  ) {
    return node.children[0]!;
  }
  return node;
}

export function displayChildren(node: Node): Node[] {
  if (node.type !== 'subject') return [];
  return node.children.map(unwrap);
}

export function pathTo(index: TreeIndex, id: string): Node[] {
  const path: Node[] = [];
  let current: string | undefined = id;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const node = index.byId.get(current);
    if (!node) break;
    path.unshift(node);
    current = index.parentOf.get(current);
  }
  return path;
}

/**
 * In-document search.
 *
 * Matches subject labels, question labels and text headings — never hint
 * bodies, because a search that surfaces answers is a search that spoils.
 */
export function searchLabels(
  index: TreeIndex,
  query: string,
  limit = 40,
): TreeIndex['searchable'] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  return index.searchable
    .filter((item) => item.type !== 'link' && item.label.toLowerCase().includes(needle))
    .slice(0, limit);
}

export function rootOf(document: HintDocument): SubjectNode {
  return document.root;
}
