/**
 * Download pipeline: fetch -> unzip -> parse -> store.
 *
 * Everything a document needs is written to IndexedDB in one transaction, so a
 * download either fully lands or does not appear in the library at all. After
 * this returns, the document is readable with the network switched off.
 */

import { unzipSync } from 'fflate';

import type { CatalogEntry } from '../api/client';
import { api } from '../api/client';
import type { HintDocument, ParseResult } from '../parser/ast';
import { parseInvisiclues } from '../parser/invisiclues';
import { parseUhs } from '../parser/uhs';
import { parseWikiWalkthrough } from '../parser/wikitext';
import { putDocument, type StoredDocument } from './db';

export interface DownloadResult {
  stored: StoredDocument;
  warnings: string[];
}

/** Rough byte size of a stored document, for the library's size column. */
function estimateSize(document: HintDocument, raw: number): number {
  let images = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const typed = node as Record<string, unknown>;
    if (typed['type'] === 'image' && typed['data'] instanceof Uint8Array) {
      images += (typed['data'] as Uint8Array).length;
    }
    for (const value of Object.values(typed)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(document.root);
  // JSON overhead is roughly the text length; images are counted exactly.
  return raw + images + JSON.stringify(document, (k, v) => (k === 'data' ? '' : v)).length;
}

function toStored(result: ParseResult, rawSize: number): StoredDocument {
  const { document } = result;
  const stored: StoredDocument = {
    id: document.id,
    title: document.game.title,
    normalizedTitle: document.game.title.toLowerCase(),
    sourceKind: document.source.kind,
    sourceUrl: document.source.url,
    license: document.source.license,
    personalUseOnly: document.source.personalUseOnly,
    fetchedAt: document.fetchedAt,
    size: estimateSize(document, rawSize),
    warnings: result.warnings,
    document,
  };
  if (document.source.attribution) stored.attribution = document.source.attribution;
  return stored;
}

/**
 * Decode a text hint file.
 *
 * IF Archive text is usually UTF-8 but plenty of it predates that; a strict
 * decode that throws tells us to fall back to Latin-1 rather than litter the
 * text with replacement characters. (This lives outside `src/parser/` because
 * the parser must stay free of platform APIs.)
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
    return out;
  }
}

/** Pull the single .uhs member out of a downloaded zip (or accept raw bytes). */
export function extractUhs(bytes: Uint8Array): Uint8Array {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return bytes;

  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const uhsName =
    names.find((n) => n.toLowerCase().endsWith('.uhs')) ??
    names.find((n) => !n.endsWith('/'));
  if (!uhsName) throw new Error('The downloaded archive contains no .uhs file.');
  return files[uhsName]!;
}

export interface DownloadOptions {
  decodeIncentive?: boolean;
  signal?: AbortSignal;
}

export async function downloadEntry(
  entry: CatalogEntry,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  switch (entry.sourceKind) {
    case 'uhs':
      return downloadUhs(entry, options);
    case 'ifarchive':
      return downloadIfArchive(entry, options);
    case 'strategywiki':
      return downloadStrategyWiki(entry, options);
    case 'ifdb':
      throw new Error(
        'IFDB is a metadata catalogue, not a hint source — use the IF Archive or UHS entry for this game.',
      );
    default:
      throw new Error(`Downloading from ${entry.sourceKind} is not supported yet.`);
  }
}

async function downloadUhs(
  entry: CatalogEntry,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const zip = await api.uhsFile(entry.ref, options.signal);
  const uhs = extractUhs(zip);
  const result = parseUhs(uhs, {
    url: entry.ref,
    decodeIncentive: options.decodeIncentive ?? false,
    ...(entry.meta?.date ? { revision: entry.meta.date } : {}),
  });

  const stored = toStored(result, uhs.length);
  // Prefer the catalog's title: it is the human-facing one, and the file's
  // internal label is sometimes a bare key seed.
  if (entry.title) {
    stored.title = entry.title;
    stored.document.game.sourceTitle = result.document.game.title;
    stored.document.game.title = entry.title;
  }
  stored.normalizedTitle = stored.title.toLowerCase();

  await putDocument(stored, {
    id: stored.id,
    bytes: uhs,
    contentType: 'application/x-uhs',
  });
  return { stored, warnings: result.warnings };
}

async function downloadIfArchive(
  entry: CatalogEntry,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const bytes = await api.ifArchiveFile(entry.ref, options.signal);

  // solutions/uhs/ holds real UHS files; everything else is text.
  const isUhs =
    entry.ref.toLowerCase().endsWith('.uhs') ||
    (bytes[0] === 0x55 && bytes[1] === 0x48 && bytes[2] === 0x53);

  const url = `https://ifarchive.org/${entry.ref.replace(/^\/+/, '')}`;
  const result = isUhs
    ? parseUhs(bytes, { url, decodeIncentive: options.decodeIncentive ?? false })
    : parseInvisiclues(decodeText(bytes), { url, title: entry.title });

  const stored = toStored(result, bytes.length);
  stored.title = entry.title || stored.title;
  stored.normalizedTitle = stored.title.toLowerCase();

  await putDocument(stored, {
    id: stored.id,
    bytes,
    contentType: isUhs ? 'application/x-uhs' : 'text/plain',
  });
  return { stored, warnings: result.warnings };
}

interface WikiRevisionsResponse {
  query?: {
    pages?: {
      title?: string;
      missing?: boolean;
      revisions?: { revid?: number; slots?: { main?: { content?: string } } }[];
    }[];
  };
}

interface WikiAllPagesResponse {
  query?: { allpages?: { title?: string }[] };
}

async function downloadStrategyWiki(
  entry: CatalogEntry,
  options: DownloadOptions,
): Promise<DownloadResult> {
  // A game is a tree of sub-pages: fetch the lot, in page order.
  const gameTitle = entry.ref.split('/')[0]!;
  const index = await api.strategyWiki<WikiAllPagesResponse>(
    {
      action: 'query',
      list: 'allpages',
      apprefix: `${gameTitle}/`,
      aplimit: '100',
      apnamespace: '0',
    },
    options.signal,
  );

  const pages = [gameTitle, ...(index.query?.allpages ?? []).map((p) => p.title ?? '')]
    .filter(Boolean)
    // Skip the noise: table-of-contents pages duplicate the tree we build.
    .filter((title) => !/\/(Table[ _]of[ _]Contents)$/i.test(title));

  const fetched: { title: string; wikitext: string; revision: string | null }[] = [];
  // Serial, as MediaWiki asks (spec §6.3).
  for (const title of pages) {
    const response = await api.strategyWiki<WikiRevisionsResponse>(
      {
        action: 'query',
        prop: 'revisions',
        titles: title,
        rvslots: 'main',
        rvprop: 'content|ids',
      },
      options.signal,
    );
    const page = response.query?.pages?.[0];
    if (!page || page.missing) continue;
    const revision = page.revisions?.[0];
    fetched.push({
      title: page.title ?? title,
      wikitext: revision?.slots?.main?.content ?? '',
      revision: revision?.revid !== undefined ? String(revision.revid) : null,
    });
  }

  if (fetched.length === 0) throw new Error(`No StrategyWiki pages found for "${gameTitle}".`);

  const result = parseWikiWalkthrough(fetched, {
    kind: 'strategywiki',
    gameTitle,
    baseUrl: 'https://strategywiki.org/wiki/',
    license: 'CC-BY-SA-4.0',
    personalUseOnly: false,
  });

  const stored = toStored(result, fetched.reduce((n, p) => n + p.wikitext.length, 0));
  await putDocument(stored, {
    id: stored.id,
    bytes: new TextEncoder().encode(JSON.stringify(fetched)),
    contentType: 'application/json',
  });
  return { stored, warnings: result.warnings };
}
