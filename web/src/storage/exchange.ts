/**
 * Library export / import.
 *
 * Two shapes, because they answer two different questions.
 *
 * **Backup** is everything: every document, its original bytes, your reveal
 * state and your settings. It is what you want when moving to a new phone or
 * before clearing site data, and it necessarily contains personal-use-only
 * material — a backup that silently dropped most of your library would not be
 * a backup. The caller has to pass `acknowledgedPersonalUse`, which the UI
 * collects as an explicit confirmation, and the manifest records the same fact
 * so the file itself says what it is.
 *
 * **Shareable** is the subset that carries no redistribution restriction, and
 * is the default. Personal-use-only documents are listed in `excluded` rather
 * than silently dropped.
 *
 * Neither is a distribution channel. Copying your own hint files between your
 * own devices is personal use; putting the zip somewhere other people can
 * reach it is not, and no amount of confirmation in this app makes it so
 * (spec §7.3, §11).
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { deserializeDocument, serializeDocument } from '../parser/serialize';
import {
  getBlob,
  listDocuments,
  listRevealStates,
  listSettings,
  putDocument,
  putRevealState,
  setSetting,
  type RevealState,
  type StoredDocument,
} from './db';

/**
 * Bumped to 2 when backups arrived: a v2 file may contain `scope`,
 * `reveal/` and `settings.json`, none of which a v1 reader expects. v1 files
 * are still importable — they are just a backup with no state in them.
 */
export const EXPORT_VERSION = 2;

export type ExportScope = 'shareable' | 'backup';

export interface ExportManifest {
  version: number;
  exportedAt: string;
  scope: ExportScope;
  /** True when the file contains material that must not be redistributed. */
  containsPersonalUseOnly: boolean;
  /** Written into the file so it still says what it is once it is off-device. */
  notice?: string;
  documents: { id: string; title: string; sourceKind: string; license: string }[];
  /** Titles left out because their source forbids redistribution. */
  excluded: { title: string; reason: string }[];
  counts: {
    documents: number;
    revealStates: number;
    settings: number;
    preferences: number;
  };
}

export interface ExportResult {
  bytes: Uint8Array;
  manifest: ExportManifest;
}

export interface ExportOptions {
  scope?: ExportScope;
  /**
   * Required for `scope: 'backup'`. The UI collects this as a checkbox the user
   * has to tick; refusing to default it is the point.
   */
  acknowledgedPersonalUse?: boolean;
}

/**
 * Theme and text size live in `localStorage`, not IndexedDB — they have to be
 * readable synchronously, before the first paint, or the app flashes the wrong
 * theme on every launch. That puts them outside `listSettings()`, so a backup
 * that promised "your settings" and silently dropped them would be lying.
 *
 * Everything the app owns there is namespaced `omni-uhs:`, so backing up the
 * prefix keeps this correct as preferences are added.
 */
const PREFERENCE_PREFIX = 'omni-uhs:';

function readPreferences(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFERENCE_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) out[key] = value;
    }
  } catch {
    // Private mode, or storage disabled. A backup without preferences beats no
    // backup at all.
  }
  return out;
}

function writePreferences(preferences: Record<string, string>): number {
  let written = 0;
  for (const [key, value] of Object.entries(preferences)) {
    if (!key.startsWith(PREFERENCE_PREFIX) || typeof value !== 'string') continue;
    try {
      localStorage.setItem(key, value);
      written += 1;
    } catch {
      /* as above */
    }
  }
  return written;
}

const BACKUP_NOTICE =
  'Personal use only. This archive contains hint content that may not be ' +
  'redistributed — it is a backup of one person\'s library, for their own ' +
  'devices. Do not publish or share it.';

export async function exportLibrary(options: ExportOptions = {}): Promise<ExportResult> {
  const scope = options.scope ?? 'shareable';
  if (scope === 'backup' && !options.acknowledgedPersonalUse) {
    throw new Error(
      'A full backup includes personal-use-only material, so it needs an explicit ' +
        'personal-use acknowledgement.',
    );
  }

  const all = await listDocuments();
  const included = scope === 'backup' ? all : all.filter((d) => !d.personalUseOnly);
  const excluded =
    scope === 'backup'
      ? []
      : all
          .filter((d) => d.personalUseOnly)
          .map((d) => ({
            title: d.title,
            reason: `${d.license} — personal use only, excluded from a shareable export`,
          }));

  const files: Record<string, Uint8Array> = {};

  for (const document of included) {
    const payload = {
      ...document,
      document: serializeDocument(document.document),
    };
    files[`documents/${document.id}.json`] = strToU8(JSON.stringify(payload));
    const blob = await getBlob(document.id);
    if (blob) files[`blobs/${document.id}.bin`] = blob.bytes;
  }

  // Reveal state and settings only ride along in a backup. They are yours, not
  // something to hand to someone else — a shareable export carrying how far you
  // got through each game would be a strange thing to send.
  let revealStates: RevealState[] = [];
  let settings: Record<string, unknown> = {};
  let preferences: Record<string, string> = {};
  if (scope === 'backup') {
    const ids = new Set(included.map((d) => d.id));
    revealStates = (await listRevealStates()).filter((state) => ids.has(state.id));
    for (const state of revealStates) {
      files[`reveal/${state.id}.json`] = strToU8(JSON.stringify(state));
    }
    settings = await listSettings();
    files['settings.json'] = strToU8(JSON.stringify(settings, null, 2));
    preferences = readPreferences();
    files['preferences.json'] = strToU8(JSON.stringify(preferences, null, 2));
  }

  const manifest: ExportManifest = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    containsPersonalUseOnly: included.some((d) => d.personalUseOnly),
    ...(scope === 'backup' ? { notice: BACKUP_NOTICE } : {}),
    documents: included.map((d) => ({
      id: d.id,
      title: d.title,
      sourceKind: d.sourceKind,
      license: d.license,
    })),
    excluded,
    counts: {
      documents: included.length,
      revealStates: revealStates.length,
      settings: Object.keys(settings).length,
      preferences: Object.keys(preferences).length,
    },
  };

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  if (scope === 'backup') files['PERSONAL-USE-ONLY.txt'] = strToU8(`${BACKUP_NOTICE}\n`);

  // `zipSync` holds the uncompressed entries and the finished archive in memory
  // at once, so peak use is roughly twice the library. That is fine at the sizes
  // this deals with: measured against the live UHS catalogue, the median title
  // is 36 KB, the largest is 4.7 MB, and *all 500* would come to 68 MB — and a
  // real library is a few dozen titles, so single-digit megabytes.
  //
  // Streaming would not help where it would matter anyway: iOS Safari, the
  // target platform, has no way to stream a download, so the whole archive has
  // to become a Blob before it can be handed to a link either way. The size is
  // reported back to the caller so a library heading for trouble is visible
  // rather than a surprise.
  return { bytes: zipSync(files, { level: 6 }), manifest };
}

export interface ImportResult {
  imported: number;
  revealStates: number;
  settings: number;
  preferences: number;
  scope: ExportScope;
  skipped: string[];
}

export async function importLibrary(bytes: Uint8Array): Promise<ImportResult> {
  const files = unzipSync(bytes);
  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new Error('Not an Omni UHS export: manifest.json is missing.');

  const manifest = JSON.parse(strFromU8(manifestRaw)) as Partial<ExportManifest>;
  // Read anything up to the current version. A v1 file is simply a shareable
  // export with no reveal state in it, and refusing to restore someone's older
  // backup would defeat the point of having one.
  if (typeof manifest.version !== 'number' || manifest.version > EXPORT_VERSION) {
    throw new Error(
      `Unsupported export version ${String(manifest.version)} — this build reads up to ${EXPORT_VERSION}.`,
    );
  }

  const skipped: string[] = [];
  let imported = 0;
  let revealStates = 0;
  let settings = 0;
  let preferences = 0;

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

  // Reveal state after the documents, so a partially-failed import never leaves
  // progress attached to a title that is not there.
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith('reveal/') || !name.endsWith('.json')) continue;
    try {
      await putRevealState(JSON.parse(strFromU8(content)) as RevealState);
      revealStates += 1;
    } catch (error) {
      skipped.push(`${name}: ${(error as Error).message}`);
    }
  }

  const settingsRaw = files['settings.json'];
  if (settingsRaw) {
    try {
      const parsed = JSON.parse(strFromU8(settingsRaw)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        await setSetting(key, value);
        settings += 1;
      }
    } catch (error) {
      skipped.push(`settings.json: ${(error as Error).message}`);
    }
  }

  const preferencesRaw = files['preferences.json'];
  if (preferencesRaw) {
    try {
      preferences = writePreferences(
        JSON.parse(strFromU8(preferencesRaw)) as Record<string, string>,
      );
    } catch (error) {
      skipped.push(`preferences.json: ${(error as Error).message}`);
    }
  }

  return {
    imported,
    revealStates,
    settings,
    preferences,
    scope: manifest.scope ?? 'shareable',
    skipped,
  };
}
