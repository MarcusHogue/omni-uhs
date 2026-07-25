/**
 * Library export / import.
 *
 * A durability escape hatch: IndexedDB is client-side and rebuildable, but
 * re-downloading a whole library is tedious, so the user can take a copy with
 * them.
 *
 * Documents whose source is `personalUseOnly` are excluded, without exception
 * (spec §7.3, §11). That covers every UHS file and every non-commercially
 * licensed wiki, which is most of the library — the export is honest about
 * what it left behind rather than silently shrinking.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { deserializeDocument, serializeDocument } from '../parser/serialize';
import { getBlob, listDocuments, putDocument, type StoredDocument } from './db';

export const EXPORT_VERSION = 1;

export interface ExportManifest {
  version: number;
  exportedAt: string;
  documents: { id: string; title: string; sourceKind: string; license: string }[];
  /** Titles left out because their source forbids redistribution. */
  excluded: { title: string; reason: string }[];
}

export interface ExportResult {
  bytes: Uint8Array;
  manifest: ExportManifest;
}

export async function exportLibrary(): Promise<ExportResult> {
  const all = await listDocuments();
  const exportable = all.filter((d) => !d.personalUseOnly);
  const excluded = all
    .filter((d) => d.personalUseOnly)
    .map((d) => ({
      title: d.title,
      reason: `${d.license} — personal use only, never exported`,
    }));

  const manifest: ExportManifest = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    documents: exportable.map((d) => ({
      id: d.id,
      title: d.title,
      sourceKind: d.sourceKind,
      license: d.license,
    })),
    excluded,
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  };

  for (const document of exportable) {
    const payload = {
      ...document,
      document: serializeDocument(document.document),
    };
    files[`documents/${document.id}.json`] = strToU8(JSON.stringify(payload));
    const blob = await getBlob(document.id);
    if (blob) files[`blobs/${document.id}.bin`] = blob.bytes;
  }

  return { bytes: zipSync(files, { level: 6 }), manifest };
}

export interface ImportResult {
  imported: number;
  skipped: string[];
}

export async function importLibrary(bytes: Uint8Array): Promise<ImportResult> {
  const files = unzipSync(bytes);
  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new Error('Not a Hint Reader export: manifest.json is missing.');

  const manifest = JSON.parse(strFromU8(manifestRaw)) as ExportManifest;
  if (manifest.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version ${manifest.version}.`);
  }

  const skipped: string[] = [];
  let imported = 0;

  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith('documents/') || !name.endsWith('.json')) continue;
    try {
      const payload = JSON.parse(strFromU8(content)) as StoredDocument & { document: unknown };
      const stored: StoredDocument = {
        ...payload,
        document: deserializeDocument(payload.document),
      };
      const blobBytes = files[`blobs/${stored.id}.bin`];
      await putDocument(
        stored,
        blobBytes
          ? { id: stored.id, bytes: blobBytes, contentType: 'application/octet-stream' }
          : undefined,
      );
      imported += 1;
    } catch (error) {
      skipped.push(`${name}: ${(error as Error).message}`);
    }
  }

  return { imported, skipped };
}
