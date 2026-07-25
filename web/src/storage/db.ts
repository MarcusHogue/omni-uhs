/**
 * IndexedDB — the whole point of the app.
 *
 * Everything needed to read a hint file lives here: the parsed AST, the
 * original bytes it came from, and the per-document reveal state. Reading never
 * touches the network, which is the headline requirement (spec §7.3).
 *
 * Raw bytes are kept alongside the AST deliberately: if the parser improves, a
 * document can be re-parsed offline instead of re-downloaded.
 */

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type { HintDocument, SourceKind } from '../parser/ast';

export interface StoredDocument {
  id: string;
  title: string;
  normalizedTitle: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  license: string;
  attribution?: string;
  personalUseOnly: boolean;
  fetchedAt: string;
  /** Bytes of the parsed AST + raw blob, for the library's size display. */
  size: number;
  warnings: string[];
  document: HintDocument;
}

export interface StoredBlob {
  id: string;
  /** The original download: a .uhs file, a zip, or the source text. */
  bytes: Uint8Array;
  contentType: string;
}

export interface RevealState {
  id: string;
  /** node id -> how many hints of that group the user has revealed. */
  revealed: Record<string, number>;
  updatedAt: string;
}

interface OmniUhsDB extends DBSchema {
  documents: {
    key: string;
    value: StoredDocument;
    indexes: { 'by-title': string; 'by-source': string };
  };
  blobs: { key: string; value: StoredBlob };
  revealState: { key: string; value: RevealState };
  settings: { key: string; value: unknown };
}

const DB_NAME = 'omni-uhs';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<OmniUhsDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<OmniUhsDB>> {
  dbPromise ??= openDB<OmniUhsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const documents = db.createObjectStore('documents', { keyPath: 'id' });
      documents.createIndex('by-title', 'normalizedTitle');
      documents.createIndex('by-source', 'sourceKind');
      db.createObjectStore('blobs', { keyPath: 'id' });
      db.createObjectStore('revealState', { keyPath: 'id' });
      db.createObjectStore('settings');
    },
  });
  return dbPromise;
}

/** Test seam. */
export function resetDb(): void {
  dbPromise = null;
}

export async function putDocument(
  stored: StoredDocument,
  blob?: StoredBlob,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['documents', 'blobs'], 'readwrite');
  await tx.objectStore('documents').put(stored);
  if (blob) await tx.objectStore('blobs').put(blob);
  await tx.done;
}

export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  return (await getDb()).get('documents', id);
}

export async function listDocuments(): Promise<StoredDocument[]> {
  const all = await (await getDb()).getAll('documents');
  return all.sort((a, b) => a.title.localeCompare(b.title));
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['documents', 'blobs', 'revealState'], 'readwrite');
  await tx.objectStore('documents').delete(id);
  await tx.objectStore('blobs').delete(id);
  await tx.objectStore('revealState').delete(id);
  await tx.done;
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  return (await getDb()).get('blobs', id);
}

export async function getRevealState(id: string): Promise<RevealState> {
  const stored = await (await getDb()).get('revealState', id);
  return stored ?? { id, revealed: {}, updatedAt: new Date().toISOString() };
}

export async function setRevealed(
  id: string,
  nodeId: string,
  count: number,
): Promise<RevealState> {
  const db = await getDb();
  const current = (await db.get('revealState', id)) ?? {
    id,
    revealed: {},
    updatedAt: new Date().toISOString(),
  };
  const next: RevealState = {
    id,
    revealed: { ...current.revealed, [nodeId]: Math.max(current.revealed[nodeId] ?? 0, count) },
    updatedAt: new Date().toISOString(),
  };
  await db.put('revealState', next);
  return next;
}

export async function clearRevealState(id: string): Promise<void> {
  await (await getDb()).delete('revealState', id);
}

/** Every document's reveal progress — for a full backup. */
export async function listRevealStates(): Promise<RevealState[]> {
  return (await getDb()).getAll('revealState');
}

/**
 * Restore reveal progress.
 *
 * Merged rather than overwritten, and always upwards: importing a backup made
 * before you read further should not un-reveal hints you have since seen. The
 * store only ever counts how much has been shown, so `max` is the whole rule.
 */
export async function putRevealState(state: RevealState): Promise<void> {
  const db = await getDb();
  const current = await db.get('revealState', state.id);
  const revealed = { ...current?.revealed };
  for (const [nodeId, count] of Object.entries(state.revealed ?? {})) {
    revealed[nodeId] = Math.max(revealed[nodeId] ?? 0, count);
  }
  await db.put('revealState', {
    id: state.id,
    revealed,
    updatedAt: new Date().toISOString(),
  });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const value = await (await getDb()).get('settings', key);
  return (value as T | undefined) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await getDb()).put('settings', value, key);
}

/** All settings as a plain object — for a full backup. */
export async function listSettings(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const keys = await db.getAllKeys('settings');
  const values = await db.getAll('settings');
  return Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
}

/**
 * Ask the browser to keep our data.
 *
 * On iOS this matters: an *installed* (Add to Home Screen) web app is exempt
 * from Safari's 7-day unused-storage eviction, but a browser tab is not.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
