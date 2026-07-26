/**
 * Schema upgrades.
 *
 * `upgrade` runs both for a new database and for every version bump, and
 * `createObjectStore` throws on a store that already exists. An unguarded
 * upgrade therefore works perfectly until the first time the version changes,
 * and then fails on exactly the installs that have data in them — so the test
 * that matters is the one that opens an *existing* database.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';

import { beforeEach, describe, expect, it } from 'vitest';

import { getDb, resetDb } from '../../src/storage/db.js';

const DB_NAME = 'omni-uhs';

/** The v1 schema, written out as it shipped, to migrate away from. */
async function createV1(): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      const documents = database.createObjectStore('documents', { keyPath: 'id' });
      documents.createIndex('by-title', 'normalizedTitle');
      documents.createIndex('by-source', 'sourceKind');
      database.createObjectStore('blobs', { keyPath: 'id' });
      database.createObjectStore('revealState', { keyPath: 'id' });
      database.createObjectStore('settings');
    },
  });
  await db.put('documents', { id: 'uhs-1', title: 'Zork I', normalizedTitle: 'zork i' });
  await db.put('revealState', { id: 'uhs-1', revealed: { 'n:1': 2 }, updatedAt: 'then' });
  db.close();
}

describe('schema upgrades', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDb();
  });

  it('opens a fresh database', async () => {
    const db = await getDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      ['blobs', 'documents', 'revealState', 'settings'].sort(),
    );
  });

  it('upgrades an existing v1 database without throwing', async () => {
    await createV1();
    resetDb();
    // The unguarded version threw ConstraintError here, on every install that
    // had ever been used — which is the only kind that matters.
    await expect(getDb()).resolves.toBeTruthy();
  });

  it('keeps the data that was already there', async () => {
    await createV1();
    resetDb();
    const db = await getDb();
    expect(await db.get('documents', 'uhs-1')).toMatchObject({ title: 'Zork I' });
    // Reading progress is the one thing a user cannot get back by re-downloading.
    expect(await db.get('revealState', 'uhs-1')).toMatchObject({ revealed: { 'n:1': 2 } });
  });

  it('is idempotent across repeated opens', async () => {
    await createV1();
    for (let i = 0; i < 3; i++) {
      resetDb();
      await expect(getDb()).resolves.toBeTruthy();
    }
  });
});
