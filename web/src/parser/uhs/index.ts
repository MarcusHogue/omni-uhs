/**
 * UHS entry point: bytes in, `HintDocument` out.
 *
 * Never throws on a file it cannot fully understand — unknown hunks, bad
 * locators and checksum problems are all recorded in `warnings` and the rest of
 * the document is returned.
 */

import type { HintDocument, ParseResult, SubjectNode } from '../ast.js';
import { stableId } from '../id.js';
import { readContainer } from './lines.js';
import { parse88 } from './parse88.js';
import { parseNew } from './parseNew.js';

export interface UhsParseOptions {
  /** Canonical origin URL, stored on the document for attribution. */
  url?: string;
  /** ISO timestamp; injected so parsing stays deterministic under test. */
  fetchedAt?: string;
  /** File date from the catalog, when known. */
  revision?: string;
  /** Spec §11: registration-gated hints stay hidden unless explicitly enabled. */
  decodeIncentive?: boolean;
  /** Force the 88a decoy tree even when a new-format section exists. */
  prefer88a?: boolean;
}

export { readContainer } from './lines.js';
export { decode88, decodeKey, makeKey } from './cipher.js';
export { cp437Decode } from './cp437.js';
export { tokenizeMarkup, tokenizeBlock } from './markup.js';

export function parseUhs(bytes: Uint8Array, options: UhsParseOptions = {}): ParseResult {
  const container = readContainer(bytes);
  const warnings = [...container.warnings];

  const hasNewFormat = container.end88Index !== -1;
  let root: SubjectNode | null = null;
  let title = '';

  if (hasNewFormat && !options.prefer88a) {
    const parsed = parseNew(container, warnings, {
      decodeIncentive: options.decodeIncentive ?? false,
    });
    if (parsed) {
      root = parsed.root;
      title = parsed.keySeed || parsed.root.label;
    } else {
      warnings.push('Falling back to the 88a section.');
    }
  }

  if (!root) {
    const parsed = parse88(container, warnings);
    if (parsed) {
      root = parsed.root;
      title = parsed.title;
    }
  }

  if (!root) {
    // Still produce a document rather than throwing: the library screen can
    // show the title and the warnings, and the raw bytes are kept regardless.
    warnings.push('No readable hint tree found in this file.');
    root = { id: 'uhs:0', type: 'subject', label: title || 'Unreadable file', children: [] };
  }

  const url = options.url ?? '';
  const source: HintDocument['source'] = {
    kind: 'uhs',
    url,
    license: 'proprietary-personal-use',
    personalUseOnly: true,
  };
  if (options.revision) source.revision = options.revision;

  const document: HintDocument = {
    id: stableId('uhs', url || title || root.label),
    game: { title: title || root.label },
    source,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    root,
  };

  return { document, warnings };
}
