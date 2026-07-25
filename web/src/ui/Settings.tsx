import { useEffect, useRef, useState } from 'react';

import {
  getSetting,
  requestPersistence,
  setSetting,
  storageEstimate,
} from '../storage/db';
import { exportLibrary, importLibrary, type ExportManifest } from '../storage/exchange';
import { formatBytes } from './bits';
import { useLibrary } from './hooks';

export function Settings(): JSX.Element {
  const { documents, reload } = useLibrary();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [decodeIncentive, setDecodeIncentive] = useState(false);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      setEstimate(await storageEstimate());
      setPersisted((await navigator.storage?.persisted?.()) ?? false);
      setDecodeIncentive(await getSetting('decodeIncentive', false));
    })();
  }, []);

  const personalOnly = documents.filter((d) => d.personalUseOnly).length;

  return (
    <div className="settings">
      <section>
        <h2>Storage</h2>
        {estimate ? (
          <p>
            {formatBytes(estimate.usage)} used
            {estimate.quota > 0 && <> of about {formatBytes(estimate.quota)} available</>}.
          </p>
        ) : (
          <p className="muted">This browser does not report a storage estimate.</p>
        )}
        <p>
          Durable storage:{' '}
          <strong>{persisted === null ? '…' : persisted ? 'granted' : 'not granted'}</strong>
        </p>
        {persisted === false && (
          <>
            <p className="muted">
              Without it, the browser may evict your library when space runs low. On iOS,
              adding this app to the Home Screen also exempts it from Safari&rsquo;s 7-day
              eviction of unused sites.
            </p>
            <button
              type="button"
              onClick={() => {
                void requestPersistence().then(setPersisted);
              }}
            >
              Request durable storage
            </button>
          </>
        )}
      </section>

      <section>
        <h2>Registration-gated hints</h2>
        <p className="muted">
          Some UHS files mark certain hints as available only to registered users. They stay
          encrypted unless you turn this on. Turning it on affects titles you download from
          now on; re-download a title to apply it.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={decodeIncentive}
            onChange={(event) => {
              setDecodeIncentive(event.target.checked);
              void setSetting('decodeIncentive', event.target.checked);
            }}
          />
          Show registration-gated hints
        </label>
      </section>

      <section>
        <h2>Export &amp; import</h2>
        <p className="muted">
          A durability backup for your library. Titles from personal-use-only sources are
          never included — that is every UHS file, and any wiki with a non-commercial
          licence.
          {personalOnly > 0 && (
            <>
              {' '}
              {personalOnly} of your {documents.length} titles fall into that category.
            </>
          )}
        </p>
        <div className="buttons">
          <button
            type="button"
            onClick={() => {
              void (async () => {
                setMessage(null);
                const result = await exportLibrary();
                setManifest(result.manifest);
                if (result.manifest.documents.length === 0) {
                  setMessage('Nothing to export: every title in your library is personal-use-only.');
                  return;
                }
                const url = URL.createObjectURL(
                  new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
                );
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `hint-reader-export-${new Date()
                  .toISOString()
                  .slice(0, 10)}.zip`;
                anchor.click();
                URL.revokeObjectURL(url);
              })();
            }}
          >
            Export library
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import library
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void (async () => {
                setMessage(null);
                try {
                  const result = await importLibrary(new Uint8Array(await file.arrayBuffer()));
                  reload();
                  setMessage(
                    `Imported ${result.imported} title(s)` +
                      (result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : '.'),
                  );
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  event.target.value = '';
                }
              })();
            }}
          />
        </div>
        {message && <p className="muted">{message}</p>}
        {manifest && manifest.excluded.length > 0 && (
          <div className="warnings-box">
            <strong>Left out of the export:</strong>
            <ul>
              {manifest.excluded.map((item) => (
                <li key={item.title}>
                  {item.title} — {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2>About</h2>
        <p className="muted">
          A personal-use hint reader. Hint content belongs to its authors: the Universal
          Hint System (Jason Strautman) for UHS files, the individual authors for IF Archive
          material, and the contributors of each wiki. Nothing here is redistributed.
        </p>
      </section>
    </div>
  );
}
