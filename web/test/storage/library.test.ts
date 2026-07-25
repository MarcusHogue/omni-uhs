/**
 * Storage round-trips, and the one rule the export path must never break:
 * personal-use-only content does not leave the device (spec §7.3, §11).
 */

// `/auto` installs the whole IndexedDB global surface (IDBRequest, IDBKeyRange,
// …) that `idb` reaches for; the factory is swapped per test below.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { beforeEach, describe, expect, it } from 'vitest';

import type { HintDocument } from '../../src/parser/ast.js';
import { parseUhs } from '../../src/parser/uhs/index.js';
import {
  deleteDocument,
  getBlob,
  getDocument,
  getRevealState,
  listDocuments,
  putDocument,
  resetDb,
  setRevealed,
  type StoredDocument,
} from '../../src/storage/db.js';
import { exportLibrary, importLibrary } from '../../src/storage/exchange.js';
import { buildImage96a, buildNested95a } from '../../tools/fixtures/definitions.js';

function stored(document: HintDocument, overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: document.id,
    title: document.game.title,
    normalizedTitle: document.game.title.toLowerCase(),
    sourceKind: document.source.kind,
    sourceUrl: document.source.url,
    license: document.source.license,
    personalUseOnly: document.source.personalUseOnly,
    fetchedAt: document.fetchedAt,
    size: 1234,
    warnings: [],
    document,
    // Mirrors the real pipeline, which lifts attribution onto the row so the
    // library can show it without opening the document.
    ...(document.source.attribution ? { attribution: document.source.attribution } : {}),
    ...overrides,
  };
}

/** A wiki document is the only kind that may be exported. */
function wikiDocument(): HintDocument {
  return {
    id: 'strategywiki-0000000000000001',
    game: { title: 'Test Game' },
    source: {
      kind: 'strategywiki',
      url: 'https://strategywiki.org/wiki/Test_Game',
      license: 'CC-BY-SA-4.0',
      attribution: 'Test Game on strategywiki.org, revision 42 — CC-BY-SA-4.0',
      personalUseOnly: false,
      revision: '42',
    },
    fetchedAt: '2026-01-01T00:00:00.000Z',
    root: {
      id: 'p:0',
      type: 'subject',
      label: 'Test Game',
      children: [
        { id: 'p:1', type: 'text', label: 'Intro', content: [{ kind: 'run', text: 'Hello' }] },
      ],
    },
  };
}

beforeEach(() => {
  // A brand new factory per test. Deleting the database instead would block on
  // the connection the previous test left open.
  globalThis.indexedDB = new IDBFactory();
  resetDb();
});

describe('document storage', () => {
  it('round-trips a parsed document and its raw bytes', async () => {
    const bytes = buildNested95a();
    const { document } = parseUhs(bytes, { url: 'https://example.test/x.zip' });
    await putDocument(stored(document), {
      id: document.id,
      bytes,
      contentType: 'application/x-uhs',
    });

    const back = await getDocument(document.id);
    expect(back?.title).toBe(document.game.title);
    expect(back?.document.root.children.length).toBe(document.root.children.length);

    const blob = await getBlob(document.id);
    expect(blob?.bytes.length).toBe(bytes.length);
  });

  it('preserves image bytes through IndexedDB', async () => {
    const bytes = buildImage96a();
    const { document } = parseUhs(bytes, { url: 'https://example.test/i.zip' });
    await putDocument(stored(document));

    const back = await getDocument(document.id);
    const image = back!.document.root.children.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect((image as { data: Uint8Array }).data.length).toBeGreaterThan(0);
  });

  it('deleting a title also removes its blob and reveal state', async () => {
    const { document } = parseUhs(buildNested95a(), { url: 'https://example.test/d.zip' });
    await putDocument(stored(document), {
      id: document.id,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/x-uhs',
    });
    await setRevealed(document.id, 'uhs:10', 2);

    await deleteDocument(document.id);
    expect(await getDocument(document.id)).toBeUndefined();
    expect(await getBlob(document.id)).toBeUndefined();
    expect((await getRevealState(document.id)).revealed).toEqual({});
  });

  it('never lowers a reveal count', async () => {
    await setRevealed('doc', 'group', 3);
    await setRevealed('doc', 'group', 1);
    expect((await getRevealState('doc')).revealed['group']).toBe(3);
  });
});

describe('export (spec §11)', () => {
  it('excludes personal-use-only documents and says so', async () => {
    const uhs = parseUhs(buildNested95a(), { url: 'https://example.test/u.zip' }).document;
    const wiki = wikiDocument();
    await putDocument(stored(uhs));
    await putDocument(stored(wiki));

    const { bytes, manifest } = await exportLibrary();

    expect(manifest.documents.map((d) => d.title)).toEqual(['Test Game']);
    expect(manifest.excluded.map((e) => e.title)).toEqual([uhs.game.title]);
    expect(manifest.excluded[0]!.reason).toMatch(/personal use only/i);

    // Belt and braces: the excluded title must not appear anywhere in the
    // exported bytes, not even as a stray string.
    const asText = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    expect(asText).not.toContain(uhs.game.title);
  });

  it('produces an importable archive', async () => {
    await putDocument(stored(wikiDocument()), {
      id: wikiDocument().id,
      bytes: new Uint8Array([9, 8, 7]),
      contentType: 'application/json',
    });
    const { bytes } = await exportLibrary();

    await deleteDocument(wikiDocument().id);
    expect(await listDocuments()).toHaveLength(0);

    const result = await importLibrary(bytes);
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([]);

    const back = await getDocument(wikiDocument().id);
    expect(back?.title).toBe('Test Game');
    expect(back?.attribution).toContain('CC-BY-SA-4.0');
    expect((await getBlob(wikiDocument().id))?.bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('exports an empty archive rather than failing on a personal-use-only library', async () => {
    await putDocument(stored(parseUhs(buildNested95a()).document));
    const { manifest } = await exportLibrary();
    expect(manifest.documents).toEqual([]);
    expect(manifest.excluded).toHaveLength(1);
  });

  it('rejects a file that is not an export', async () => {
    await expect(importLibrary(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).rejects.toThrow();
  });
});
