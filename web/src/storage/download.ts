/**
 * Download pipeline: fetch -> unzip -> parse -> store.
 *
 * Everything a document needs is written to IndexedDB in one transaction, so a
 * download either fully lands or does not appear in the library at all. After
 * this returns, the document is readable with the network switched off.
 */

import { unzipSync } from 'fflate';

import type { CatalogEntry, WikiTransport } from '../api/client';
import { api, strategyWikiTransport, wikiTransport } from '../api/client';
import type { HintDocument, ImageNode, ParseResult } from '../parser/ast';
import { walk } from '../parser/ast';
import { parseInvisiclues } from '../parser/invisiclues';
import { parseUhs } from '../parser/uhs';
import { collectExpandable, parseWikiWalkthrough } from '../parser/wikitext';
import { orderWalkthrough, parseTableOfContents } from '../parser/wikitext/strategywiki';
import { putDocument, type StoredDocument, type StoredImage } from './db';
import { expandTemplates } from './expand';
import { fetchImages } from './images';
import { imageSettings } from './settings';

export interface DownloadResult {
  stored: StoredDocument;
  warnings: string[];
}

/**
 * Rough byte size of a stored document, for the library's size column.
 *
 * `extra` is bytes held outside the document — wiki pictures live in their own
 * store, so walking the AST for them finds nothing and the caller has to say.
 */
function estimateSize(document: HintDocument, raw: number, extra = 0): number {
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
  return raw + images + extra + JSON.stringify(document, (k, v) => (k === 'data' ? '' : v)).length;
}

function toStored(result: ParseResult, rawSize: number, extra = 0): StoredDocument {
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
    size: estimateSize(document, rawSize, extra),
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
  /**
   * Progress, so a long download does not read as a hang.
   *
   * Blue Prince fetches 280 pictures behind one button; at the proxy's
   * two-per-host politeness limit that is the better part of a minute of
   * silence otherwise.
   */
  onProgress?: (phase: 'pages' | 'images', done: number, total: number) => void;
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
    case 'fandom':
    case 'wikigg':
      return downloadWiki(entry, options);
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

/** One page's wikitext, as handed to the parser. */
interface WikiPageContent {
  title: string;
  wikitext: string;
  revision: string | null;
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

/**
 * StrategyWiki: one game, shaped and ordered the way the wiki shapes it.
 *
 * The other wikis are reference works and the download sorts them
 * alphabetically, which loses nothing. A walkthrough is the opposite case —
 * order *is* the content — and this used to sort it alphabetically too, so
 * Chrono Trigger opened on "Beyond the Ruins" and closed on "The Millennial
 * Fair": the penultimate chapter first and the opening one last.
 *
 * The order comes from the game's Table of Contents, which this used to throw
 * away as noise. It is a hand-curated map of the whole guide — twenty-eight
 * chapters in play order, then Appendices, Gameplay, Enemies, Statistics — and
 * those section names become the document's own shape. Failing that, the
 * `{{Footer Nav}}` chain the chapters carry; failing that, alphabetical with a
 * note saying so.
 */
async function downloadStrategyWiki(
  entry: CatalogEntry,
  options: DownloadOptions,
): Promise<DownloadResult> {
  // A game is a tree of sub-pages, and any of them identifies the game.
  const gameTitle = entry.ref.split('/')[0]!;

  // Not caught: a missing Table of Contents comes back as an empty list from
  // `fetchPages`, so anything that throws here is a real network failure and
  // swallowing it would turn an aborted download into a silently worse one.
  const signalOnly: DownloadOptions = options.signal ? { signal: options.signal } : {};
  const [toc, index] = await Promise.all([
    fetchPages(strategyWikiTransport, [`${gameTitle}/Table of Contents`], signalOnly),
    api.strategyWiki<WikiAllPagesResponse>(
      {
        action: 'query',
        list: 'allpages',
        apprefix: `${gameTitle}/`,
        aplimit: '200',
        apnamespace: '0',
      },
      options.signal,
    ),
  ]);

  // The index still runs, even with a Table of Contents in hand. It is the only
  // check on the ToC being complete, and a page missing from both would be lost
  // with nothing to say it ever existed.
  const listed = (index.query?.allpages ?? []).map((page) => page.title ?? '').filter(Boolean);
  const sections = toc[0] ? parseTableOfContents(toc[0].wikitext, gameTitle) : [];

  // Fetched by title rather than by prefix: Portal's Table of Contents lists
  // fourteen `Portal: Still Alive/…` pages that `apprefix=Portal/` cannot see,
  // and a prefix-only download dropped the whole expansion without a word.
  const wanted = new Set<string>([gameTitle, ...sections.flatMap((s) => s.pages), ...listed]);
  const titles = [...wanted].filter(
    // The index page itself would nest a copy of the contents inside the game.
    (title) => title && !/\/(Table[ _]of[ _]Contents)$/i.test(title),
  );

  const fetched = await fetchPages(strategyWikiTransport, titles, options);
  if (fetched.length === 0) throw new Error(`No StrategyWiki pages found for "${gameTitle}".`);

  // Reading order, before anything else looks at the pages: the parser numbers
  // sections in the order it receives them. With a Table of Contents the groups
  // carry the order, so the page list only has to be complete.
  const { ordered, notes } =
    sections.length > 0 ? { ordered: fetched, notes: [] } : orderWalkthrough(fetched, gameTitle);

  const policy = await imageSettings();
  const calls = new Set<string>();
  for (const page of ordered) for (const call of collectExpandable(page.wikitext)) calls.add(call);
  const templates = await expandTemplates(strategyWikiTransport, [...calls], options.signal);

  // StrategyWiki is written as a walkthrough with its answers already behind
  // spoiler templates, so its pages are kept as they read — and never ranked,
  // which would reorder the very thing that was just put back in order.
  const result = parseWikiWalkthrough(ordered, {
    kind: 'strategywiki',
    gameTitle,
    baseUrl: 'https://strategywiki.org/wiki/',
    documentUrl: `https://strategywiki.org/wiki/${encodeURIComponent(gameTitle.replace(/ /g, '_'))}`,
    license: 'CC-BY-SA-4.0',
    personalUseOnly: false,
    reveal: 'as-written',
    images: policy.enabled,
    expanded: templates.expanded,
    ...(sections.length > 0 ? { groups: sections } : {}),
  });
  result.warnings.push(...notes, ...templates.warnings);

  const nodes: ImageNode[] = [];
  if (policy.enabled) {
    for (const node of walk(result.document.root)) if (node.type === 'image') nodes.push(node);
  }
  const pictures = await fetchImages(strategyWikiTransport, result.document.id, nodes, policy, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (done, total) => options.onProgress?.('images', done, total),
  });
  result.warnings.push(...pictures.warnings);
  // Same rule as the other wikis: an embedded picture carries no licence of its
  // own, so a document holding one stays out of a shareable export.
  if (pictures.images.length > 0) result.document.source.personalUseOnly = true;

  return storeWiki(result, ordered, pictures.images);
}

/**
 * Fetch each page's wikitext, batched.
 *
 * MediaWiki accepts many titles in one `titles=` parameter, so a forty-page game
 * costs two requests rather than forty round trips to somebody else's server.
 * The response comes back in the API's order, not the request's, which no caller
 * relies on: both sort afterwards.
 */
async function fetchPages(
  transport: WikiTransport,
  titles: string[],
  options: DownloadOptions,
): Promise<WikiPageContent[]> {
  const fetched: WikiPageContent[] = [];
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    options.onProgress?.('pages', i, titles.length);
    const batch = titles.slice(i, i + TITLE_BATCH);
    const response = await transport.query<WikiRevisionsResponse>(
      {
        action: 'query',
        prop: 'revisions',
        titles: batch.join('|'),
        rvslots: 'main',
        rvprop: 'content|ids',
      },
      options.signal,
    );
    for (const page of response.query?.pages ?? []) {
      if (!page.title || page.missing) continue;
      const revision = page.revisions?.[0];
      fetched.push({
        title: page.title,
        wikitext: revision?.slots?.main?.content ?? '',
        revision: revision?.revid !== undefined ? String(revision.revid) : null,
      });
    }
  }
  options.onProgress?.('pages', titles.length, titles.length);
  return fetched;
}

async function storeWiki(
  result: ReturnType<typeof parseWikiWalkthrough>,
  fetched: WikiPageContent[],
  images: StoredImage[] = [],
): Promise<DownloadResult> {
  const imageBytes = images.reduce((n, image) => n + image.bytes.length, 0);
  const stored = toStored(
    result,
    fetched.reduce((n, p) => n + p.wikitext.length, 0),
    imageBytes,
  );
  await putDocument(
    stored,
    {
      id: stored.id,
      bytes: new TextEncoder().encode(JSON.stringify(fetched)),
      contentType: 'application/json',
    },
    images,
  );
  return { stored, warnings: result.warnings };
}

/**
 * How many page titles go into one `titles=` parameter.
 *
 * MediaWiki accepts 50 for anonymous callers. Twenty keeps each response a
 * sensible size and still turns a whole game into two or three requests instead
 * of forty — which is the difference between a download and a crawl.
 */
const TITLE_BATCH = 20;

/**
 * Fandom and wiki.gg: one wiki, one game, one title in the library.
 *
 * A game wiki is not a source of pages to collect individually — every page on
 * `blue-prince.fandom.com` is about Blue Prince. So the whole game arrives as a
 * single document whose sections are its pages, and the proxy decides which
 * pages those are.
 *
 * Two more things differ from StrategyWiki:
 *
 * - **The licence is read, not assumed.** These are per-wiki, and plenty of the
 *   game wikis are CC-BY-NC-SA, which has to set `personalUseOnly` and keep the
 *   game out of a shareable export.
 * - **The reveal is rebuilt.** A reference wiki marks nothing as an answer, so
 *   rendering a page as written would spoil all of it at once. Sections become
 *   questions and paragraphs become hints revealed one at a time.
 */
async function downloadWiki(
  entry: CatalogEntry,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const host = entry.host ?? entry.ref;
  if (!host || !host.includes('.')) {
    throw new Error(`This ${entry.sourceKind} result does not say which wiki it came from.`);
  }

  const site = await api.wikiSite(host, options.signal);
  const candidates = await api.wikiPages(host, options.signal);
  const gameTitle = entry.title || candidates.game;

  if (candidates.titles.length === 0) {
    throw new Error(`No readable pages found on ${host}.`);
  }

  const policy = await imageSettings();
  const transport = wikiTransport(host);

  const fetched = await fetchPages(transport, candidates.titles, options);
  if (fetched.length === 0) throw new Error(`No pages could be read from ${host}.`);

  // Alphabetical, so the same game downloaded twice reads the same way; the
  // order categories come back in is not stable and means nothing.
  fetched.sort((a, b) => a.title.localeCompare(b.title));

  // Ask the wiki what its own templates say, before parsing. Some words exist
  // only in a template's definition — `{{AW}}` is how Animal Well's pages write
  // the game's name — and no reading of the page can recover them.
  const calls = new Set<string>();
  for (const page of fetched) for (const call of collectExpandable(page.wikitext)) calls.add(call);
  const templates = await expandTemplates(transport, [...calls], options.signal);

  const result = parseWikiWalkthrough(fetched, {
    kind: entry.sourceKind,
    gameTitle,
    baseUrl: `https://${host}/wiki/`,
    // The document is the wiki, not any one of its pages.
    documentUrl: `https://${host}/wiki/`,
    license: site.license,
    personalUseOnly: site.personalUseOnly,
    reveal: 'progressive',
    rank: true,
    images: policy.enabled,
    expanded: templates.expanded,
  });
  result.warnings.push(...templates.warnings);

  if (result.document.root.children.length === 0) {
    throw new Error(`No readable content found on ${host}.`);
  }

  const nodes: ImageNode[] = [];
  if (policy.enabled) {
    for (const node of walk(result.document.root)) if (node.type === 'image') nodes.push(node);
  }

  const pictures = await fetchImages(transport, result.document.id, nodes, policy, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (done, total) => options.onProgress?.('images', done, total),
  });
  result.warnings.push(...pictures.warnings);

  // Embedded pictures make the document personal-use-only whatever the text
  // licence says. Fandom and wiki.gg publish no per-image licence at all — the
  // CC-BY-SA that covers the prose does not necessarily cover a screenshot of
  // somebody's game — so a document carrying them is kept out of a shareable
  // export. Decided with the user, cost accepted: most wiki games stop
  // appearing in a share.
  if (pictures.images.length > 0) result.document.source.personalUseOnly = true;

  return storeWiki(result, fetched, pictures.images);
}
