/**
 * Picking a size, and cleaning up after a deleted title.
 *
 * The size arithmetic is the interesting half: MediaWiki reports the byte size
 * of an original but never of a thumbnail, so a wrong rule here cannot be
 * noticed after the fact — it just quietly downloads more than it saves.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteDocument,
  deleteImages,
  findOrphanImages,
  getDb,
  getImage,
  imageKey,
  listImages,
  putDocument,
  resetDb,
  sizeOfImages,
  type StoredDocument,
  type StoredImage,
} from '../../src/storage/db.js';
import { chooseImage, type ImageInfo } from '../../src/storage/images.js';

const POLICY = { maxWidth: 640, budgetBytes: 40 * 1024 * 1024 };

const info = (overrides: Partial<ImageInfo>): ImageInfo => ({
  file: 'Door.png',
  url: 'https://static.wikia.nocookie.net/x/Door.png',
  size: 100_000,
  width: 1200,
  height: 900,
  mime: 'image/png',
  thumbUrl: 'https://static.wikia.nocookie.net/x/Door.png/scale-to-width-down/640',
  thumbWidth: 640,
  thumbHeight: 480,
  ...overrides,
});

describe('chooseImage', () => {
  it('takes the thumbnail when the original is wider', () => {
    expect(chooseImage(info({}), POLICY, 0)).toMatchObject({ fetch: 'thumb', width: 640 });
  });

  it('reports what it expects to cost, so the caller can reserve it', () => {
    // Exact for an original; an area-ratio guess for a thumbnail, because
    // MediaWiki never reports a thumbnail's byte size.
    const original = chooseImage(info({ width: 500, size: 91_000 }), POLICY, 0);
    expect(original).toMatchObject({ fetch: 'original', estimate: 91_000 });

    const thumb = chooseImage(info({ width: 1280, size: 400_000 }), POLICY, 0);
    expect(thumb).toMatchObject({ fetch: 'thumb', estimate: 100_000 });
  });

  it('takes the original when it is already narrow enough', () => {
    // The measured trap: MediaWiki re-encodes to make a thumbnail, and for a
    // small source that came back at 175 KB against a 91 KB original. It never
    // reports the thumbnail's size, so this cannot be fixed after fetching.
    const choice = chooseImage(info({ width: 500, height: 400, size: 91_000 }), POLICY, 0);
    expect(choice).toMatchObject({ fetch: 'original', width: 500 });
  });

  it('skips a sprite', () => {
    expect(chooseImage(info({ width: 6, height: 8 }), POLICY, 0)).toEqual({
      fetch: 'skip',
      reason: 'decorative',
    });
    // Tall and thin counts too: a 12px-wide divider is not content.
    expect(chooseImage(info({ width: 12, height: 400 }), POLICY, 0)).toMatchObject({
      reason: 'decorative',
    });
  });

  it('skips anything that is not an image', () => {
    expect(chooseImage(info({ mime: 'video/webm' }), POLICY, 0)).toEqual({
      fetch: 'skip',
      reason: 'unavailable',
    });
  });

  it('falls back to the original when no thumbnail is offered', () => {
    // SVG and some GIFs: wider than the target, but MediaWiki generates nothing.
    const choice = chooseImage(info({ thumbUrl: undefined, size: 20_000 }), POLICY, 0);
    expect(choice).toMatchObject({ fetch: 'original' });
  });

  it('stops at the budget rather than downloading past it', () => {
    const small = { maxWidth: 640, budgetBytes: 50_000 };
    expect(chooseImage(info({ width: 400, size: 60_000 }), small, 0)).toEqual({
      fetch: 'skip',
      reason: 'budget',
    });
    // And counts what has already been spent, not just this one picture.
    expect(chooseImage(info({ width: 400, size: 30_000 }), small, 30_000)).toEqual({
      fetch: 'skip',
      reason: 'budget',
    });
  });

  it('estimates a thumbnail from the area ratio, so a huge original still fits', () => {
    // 4000px wide, 8 MB: at 640 that is (640/4000)^2 ~= 2.6% ~= 205 KB, which
    // fits a 1 MB budget even though the original does not.
    const choice = chooseImage(
      info({ width: 4000, height: 3000, size: 8 * 1024 * 1024 }),
      { maxWidth: 640, budgetBytes: 1024 * 1024 },
      0,
    );
    expect(choice).toMatchObject({ fetch: 'thumb' });
  });
});

describe('image storage', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDb();
  });

  const document = (id: string): StoredDocument =>
    ({
      id,
      title: id,
      normalizedTitle: id,
      sourceKind: 'fandom',
      sourceUrl: `https://${id}.fandom.com/wiki/`,
      license: 'CC-BY-SA',
      personalUseOnly: true,
      fetchedAt: 'now',
      size: 1,
      warnings: [],
      document: { id, game: { title: id }, source: {}, fetchedAt: 'now', root: {} },
    }) as unknown as StoredDocument;

  /** A document whose tree really points at the picture, as a download's would. */
  const withImage = (id: string, file: string): StoredDocument => {
    const stored = document(id);
    stored.document.root = {
      id: 'p:0',
      type: 'subject',
      label: id,
      children: [
        {
          id: 'p:0.p0',
          type: 'hints',
          label: 'Q',
          hints: [
            {
              id: 'p:0.p0:h0',
              type: 'hint',
              content: [],
              images: [
                {
                  id: 'p:0.p0:h0:i0',
                  type: 'image',
                  label: file,
                  data: new Uint8Array(0),
                  mime: 'image/webp',
                  blobKey: imageKey(id, file),
                  source: { file },
                },
              ],
            },
          ],
        },
      ],
    } as never;
    return stored;
  };

  const picture = (documentId: string, file: string): StoredImage => ({
    key: imageKey(documentId, file),
    documentId,
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/webp',
    width: 640,
    height: 480,
  });

  it('stores pictures with their document and reads them back by key', async () => {
    await putDocument(document('blue'), undefined, [picture('blue', 'Door.png')]);
    expect(await getImage('blue|Door.png')).toMatchObject({ mime: 'image/webp' });
    expect(await listImages('blue')).toHaveLength(1);
  });

  it('replaces the picture set on a re-download rather than adding to it', async () => {
    await putDocument(document('blue'), undefined, [
      picture('blue', 'One.png'),
      picture('blue', 'Two.png'),
    ]);
    await putDocument(document('blue'), undefined, [picture('blue', 'Three.png')]);

    expect((await listImages('blue')).map((image) => image.key)).toEqual(['blue|Three.png']);
  });

  it('leaves nothing behind when a re-download turns images off', async () => {
    // The leak this guards is a licence one, not a disk one. A wiki's document
    // id is stable, so a re-download overwrites it; with images off the
    // replacement is no longer personal-use-only, and a shareable export would
    // then find the previous download's rows through `listImages` and put
    // unlicensed pictures in an archive meant to carry none.
    await putDocument(document('blue'), undefined, [picture('blue', 'One.png')]);
    await putDocument({ ...document('blue'), personalUseOnly: false }, undefined, []);

    expect(await listImages('blue')).toEqual([]);
  });

  it('leaves the pictures alone when it is not asked about them', async () => {
    // Omitting the argument means "no opinion" — the UHS and IF Archive paths
    // pass nothing and must not wipe a wiki game's pictures by association.
    await putDocument(document('blue'), undefined, [picture('blue', 'One.png')]);
    await putDocument(document('blue'));

    expect(await listImages('blue')).toHaveLength(1);
  });

  it('finds nothing to reclaim when every picture is referenced', async () => {
    await putDocument(withImage('blue', 'Door.png'), undefined, [picture('blue', 'Door.png')]);
    expect(await findOrphanImages()).toEqual([]);
  });

  it('finds the rows an older build left behind on re-download', async () => {
    // Before the fix, `putDocument` upserted the new pictures and left the old
    // set in place, so re-downloading a game stranded its previous images. The
    // fix stops new ones; these are the ones already on disk. Written straight
    // into the store to reproduce that state.
    await putDocument(withImage('blue', 'New.png'), undefined, [picture('blue', 'New.png')]);
    const db = await getDb();
    await db.put('images', picture('blue', 'Stale-one.png'));
    await db.put('images', picture('blue', 'Stale-two.png'));

    const orphans = await findOrphanImages();
    expect(orphans.sort()).toEqual(['blue|Stale-one.png', 'blue|Stale-two.png']);
    expect(await sizeOfImages(orphans)).toBe(6);

    await deleteImages(orphans);
    expect(await findOrphanImages()).toEqual([]);
    // And the referenced one is untouched.
    expect(await getImage('blue|New.png')).toBeTruthy();
  });

  it('does not mistake another document\'s pictures for orphans', async () => {
    await putDocument(withImage('blue', 'A.png'), undefined, [picture('blue', 'A.png')]);
    await putDocument(withImage('well', 'B.png'), undefined, [picture('well', 'B.png')]);
    expect(await findOrphanImages()).toEqual([]);
  });

  it('takes every picture with the document when it is deleted', async () => {
    // The failure this guards is invisible: orphaned rows are tens of megabytes
    // that nothing will ever read again, and nothing surfaces them until the
    // storage quota fills up.
    await putDocument(document('blue'), undefined, [
      picture('blue', 'One.png'),
      picture('blue', 'Two.png'),
      picture('blue', 'Three.png'),
    ]);
    await putDocument(document('well'), undefined, [picture('well', 'Rabbit.png')]);

    await deleteDocument('blue');

    expect(await listImages('blue')).toEqual([]);
    expect(await getImage('blue|Two.png')).toBeUndefined();
    // And leaves the other title's pictures alone.
    expect(await listImages('well')).toHaveLength(1);
  });
});
