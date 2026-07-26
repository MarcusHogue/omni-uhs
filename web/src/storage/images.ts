/**
 * Fetching wiki pictures and deciding which are worth keeping.
 *
 * The measurements this is built on, taken against Blue Prince's top 60 pages:
 * 280 distinct pictures, **413 MB** at full size and **11 MB** at 640px. So
 * thumbnails are stored offline and the original is fetched on demand, on a tap
 * — a decision taken with the user, not a guess.
 *
 * Two things about the sizes are counter-intuitive enough to be worth stating,
 * because both are load-bearing below:
 *
 * - **A thumbnail can be bigger than the original.** MediaWiki re-encodes to
 *   produce one, and for an image already under the target width that is pure
 *   loss — 175 KB measured against a 91 KB source. `imageinfo` reports the
 *   original's byte size but *not* the thumbnail's, so this cannot be caught
 *   after the fact; it has to be decided from the width before asking.
 * - **Some pictures are 6×8 pixels.** Sprites and separators outnumber content
 *   on some pages, and the reliable test is dimensions, which only `imageinfo`
 *   knows.
 *
 * `chooseImage` is pure and holds all of that; everything else here is plumbing.
 */

import { api } from '../api/client';
import type { ImageNode } from '../parser/ast';
import { imageKey, type StoredImage } from './db';

/** What `imageinfo` says about one file. */
export interface ImageInfo {
  file: string;
  /** Original bytes. */
  url: string;
  size: number;
  width: number;
  height: number;
  mime: string;
  /** Only present when MediaWiki generated one, i.e. the original is wider. */
  thumbUrl?: string;
  thumbWidth?: number;
  thumbHeight?: number;
}

export interface ImagePolicy {
  /** Target width. Only 640 has been measured; see the note in Settings. */
  maxWidth: number;
  /** Ceiling for one document, in bytes. */
  budgetBytes: number;
}

export type ImageChoice =
  | { fetch: 'thumb' | 'original'; url: string; width: number; height: number }
  | { fetch: 'skip'; reason: 'decorative' | 'budget' | 'unavailable' };

/**
 * Below this, on either side, a picture is furniture: a sprite, a bullet, a
 * separator. 64 is above every icon measured and below every screenshot.
 */
const MIN_DIMENSION = 64;

/**
 * Which version of a picture to fetch, if any.
 *
 * Pure, so the size arithmetic is testable without a network: `spent` is how
 * many bytes this document has already committed.
 */
export function chooseImage(info: ImageInfo, policy: ImagePolicy, spent: number): ImageChoice {
  if (!info.mime.startsWith('image/')) return { fetch: 'skip', reason: 'unavailable' };
  if (!info.url) return { fetch: 'skip', reason: 'unavailable' };
  if (info.width > 0 && info.height > 0 && (info.width < MIN_DIMENSION || info.height < MIN_DIMENSION)) {
    return { fetch: 'skip', reason: 'decorative' };
  }

  // Already small enough: take the original. Asking for a thumbnail here costs
  // a re-encode that can come back *larger*, and `imageinfo` will not tell us
  // that until the bytes have already been fetched.
  if (info.width > 0 && info.width <= policy.maxWidth) {
    if (spent + info.size > policy.budgetBytes) return { fetch: 'skip', reason: 'budget' };
    return { fetch: 'original', url: info.url, width: info.width, height: info.height };
  }

  if (!info.thumbUrl) {
    // Wider than the target but no thumbnail offered — SVG and some GIFs. The
    // original is all there is, so it has to fit the budget on its own terms.
    if (spent + info.size > policy.budgetBytes) return { fetch: 'skip', reason: 'budget' };
    return { fetch: 'original', url: info.url, width: info.width, height: info.height };
  }

  // A thumbnail's byte size is not reported, so estimate from the area ratio.
  // Only used against the budget, never to choose between two sizes.
  const ratio = info.width > 0 ? (policy.maxWidth / info.width) ** 2 : 1;
  if (spent + info.size * ratio > policy.budgetBytes) return { fetch: 'skip', reason: 'budget' };
  return {
    fetch: 'thumb',
    url: info.thumbUrl,
    width: info.thumbWidth ?? policy.maxWidth,
    height: info.thumbHeight ?? 0,
  };
}

/** MediaWiki accepts 50 titles anonymously; 20 keeps each response small. */
const INFO_BATCH = 20;

interface ImageInfoResponse {
  query?: {
    pages?: {
      title?: string;
      missing?: boolean;
      imageinfo?: {
        url?: string;
        size?: number;
        width?: number;
        height?: number;
        mime?: string;
        thumburl?: string;
        thumbwidth?: number;
        thumbheight?: number;
      }[];
    }[];
  };
}

/**
 * Ask the wiki about a batch of files.
 *
 * `action=query` is already proxied, so this needs no new route. Files that the
 * wiki does not have simply do not come back, which is the right answer: a
 * reference to a deleted picture is not an error worth stopping a download for.
 */
export async function resolveImages(
  host: string,
  files: string[],
  maxWidth: number,
  signal?: AbortSignal,
): Promise<Map<string, ImageInfo>> {
  const found = new Map<string, ImageInfo>();
  for (let i = 0; i < files.length; i += INFO_BATCH) {
    const batch = files.slice(i, i + INFO_BATCH);
    const response = await api.wiki<ImageInfoResponse>(
      host,
      {
        action: 'query',
        prop: 'imageinfo',
        iiprop: 'url|size|mime|dimensions',
        iiurlwidth: String(maxWidth),
        titles: batch.map((file) => `File:${file}`).join('|'),
      },
      signal,
    );
    for (const page of response.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!page.title || page.missing || !info?.url) continue;
      const file = page.title.replace(/^File:/i, '');
      const entry: ImageInfo = {
        file,
        url: info.url,
        size: info.size ?? 0,
        width: info.width ?? 0,
        height: info.height ?? 0,
        mime: info.mime ?? '',
      };
      if (info.thumburl) {
        entry.thumbUrl = info.thumburl;
        if (info.thumbwidth !== undefined) entry.thumbWidth = info.thumbwidth;
        if (info.thumbheight !== undefined) entry.thumbHeight = info.thumbheight;
      }
      found.set(file, entry);
    }
  }
  return found;
}

/**
 * How many pictures to fetch at once.
 *
 * The real throttle is the proxy's `perHostConcurrency: 2`, which must not be
 * raised — this is somebody else's CDN. Four in flight keeps that queue fed
 * without the client sitting idle between round trips.
 */
const POOL = 4;

export interface ImageFetchResult {
  images: StoredImage[];
  bytes: number;
  warnings: string[];
}

/**
 * Fetch the pictures a document refers to and mark up its nodes.
 *
 * The nodes are mutated in place: each gets either a `blobKey` and its real
 * dimensions, or an `omitted` reason. Nothing is removed — a picture that could
 * not be fetched still shows its caption and a link out, which on a page whose
 * caption is "Solution to the Antechamber door" is the difference between a
 * dead end and a next step.
 */
export async function fetchImages(
  host: string,
  documentId: string,
  nodes: ImageNode[],
  policy: ImagePolicy,
  options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ImageFetchResult> {
  const warnings: string[] = [];
  const images: StoredImage[] = [];
  if (nodes.length === 0) return { images, bytes: 0, warnings };

  // The same picture is often referenced from several hints; fetch once and
  // point every node at the one row.
  const byFile = new Map<string, ImageNode[]>();
  for (const node of nodes) {
    const file = node.source?.file;
    if (!file) continue;
    const list = byFile.get(file);
    if (list) list.push(node);
    else byFile.set(file, [node]);
  }

  const info = await resolveImages(host, [...byFile.keys()], policy.maxWidth, options.signal);

  let spent = 0;
  let done = 0;
  const files = [...byFile.keys()];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let i = next++; i < files.length; i = next++) {
      const file = files[i]!;
      const targets = byFile.get(file)!;
      const found = info.get(file);
      const choice: ImageChoice = found
        ? chooseImage(found, policy, spent)
        : { fetch: 'skip', reason: 'unavailable' };

      if (choice.fetch === 'skip') {
        for (const node of targets) if (node.source) node.source.omitted = choice.reason;
        if (choice.reason === 'budget') {
          warnings.push(`${file}: skipped, the image budget for this game is full`);
        }
        options.onProgress?.(++done, files.length);
        continue;
      }

      try {
        const { bytes, mime } = await api.wikiImage(host, choice.url, options.signal);
        // Claim the budget from what was actually transferred, not from the
        // estimate: the estimate is an area ratio and is routinely wrong.
        spent += bytes.length;
        const key = imageKey(documentId, file);
        images.push({
          key,
          documentId,
          bytes,
          mime,
          width: choice.width,
          height: choice.height,
        });
        for (const node of targets) {
          node.blobKey = key;
          node.mime = mime;
          if (node.source) {
            delete node.source.omitted;
            node.source.width = choice.width;
            node.source.height = choice.height;
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        for (const node of targets) if (node.source) node.source.omitted = 'unavailable';
        warnings.push(`${file}: ${(error as Error).message}`);
      }
      options.onProgress?.(++done, files.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
  return { images, bytes: spent, warnings };
}
