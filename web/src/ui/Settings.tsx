import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { api, isOfflineError, type WikiSite } from '../api/client';
import {
  getSetting,
  requestPersistence,
  setSetting,
  storageEstimate,
} from '../storage/db';
import {
  exportLibrary,
  importLibrary,
  type ExportManifest,
  type ExportScope,
} from '../storage/exchange';
import { ErrorNote, formatBytes, Spinner } from './bits';
import { useAppUpdate, useLibrary, useOnline } from './hooks';
import { isReleaseBuild, WEB_VERSION } from './update';
import {
  applyTextScale,
  applyTheme,
  readTextScale,
  readTheme,
  THEMES,
  type TextScale,
  type ThemeId,
} from './themes';
import { LicenceLine, WikiFinder } from './WikiFinder';

export function Settings(): JSX.Element {
  const { documents, reload } = useLibrary();
  const update = useAppUpdate();
  const online = useOnline();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [decodeIncentive, setDecodeIncentive] = useState(false);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Ticked by the user before a full backup is allowed. Never persisted. */
  const [acknowledged, setAcknowledged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Seeded synchronously so the picker never disagrees with what is on screen.
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  const [scale, setScale] = useState<TextScale>(() => readTextScale());

  /** Build the zip and hand it to the browser. */
  const download = async (scope: ExportScope): Promise<void> => {
    setMessage(null);
    try {
      const result = await exportLibrary({
        scope,
        ...(scope === 'backup' ? { acknowledgedPersonalUse: acknowledged } : {}),
      });
      setManifest(result.manifest);
      if (result.manifest.documents.length === 0) {
        setMessage(
          scope === 'backup'
            ? 'Nothing to back up: your library is empty.'
            : 'Nothing to export: every title in your library is personal-use-only.',
        );
        return;
      }
      const url = URL.createObjectURL(
        new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      const kind = scope === 'backup' ? 'backup' : 'export';
      anchor.download = `omni-uhs-${kind}-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      const { counts } = result.manifest;
      setMessage(
        scope === 'backup'
          ? `Backed up ${counts.documents} title(s), ${counts.revealStates} with reading ` +
              `progress — ${formatBytes(result.bytes.length)}.`
          : `Exported ${counts.documents} title(s) — ${formatBytes(result.bytes.length)}.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  /**
   * Pull every value this screen displays back out of storage.
   *
   * An import can rewrite all of them underneath a mounted component. Leaving
   * the checkbox showing its pre-import value is not just cosmetic: the next
   * click would write the stale value back over what was just restored.
   */
  const refreshFromStorage = async (): Promise<void> => {
    setEstimate(await storageEstimate());
    setPersisted((await navigator.storage?.persisted?.()) ?? false);
    setDecodeIncentive(await getSetting('decodeIncentive', false));
    // Theme and text size come back via localStorage, so re-read and re-apply.
    const restoredTheme = readTheme();
    const restoredScale = readTextScale();
    setTheme(restoredTheme);
    setScale(restoredScale);
    applyTheme(restoredTheme);
    applyTextScale(restoredScale);
  };

  // Once on mount; `refreshFromStorage` is also called after an import.
  useEffect(() => {
    void refreshFromStorage();
  }, []);

  const personalOnly = documents.filter((d) => d.personalUseOnly).length;

  return (
    <div className="settings">
      <section>
        <h2>Theme</h2>
        <div className="theme-grid">
          {THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="theme-card"
              aria-pressed={theme === option.id}
              onClick={() => {
                setTheme(option.id);
                applyTheme(option.id);
              }}
            >
              <span className="theme-swatch" aria-hidden="true">
                {option.swatch.map((colour, i) => (
                  <span key={i} style={{ background: colour }} />
                ))}
              </span>
              <span className="theme-name">{option.name}</span>
              <span className="theme-note">{option.note}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Text size</h2>
        <p className="muted">Applies to hint and walkthrough text.</p>
        <div className="scale-row">
          {(['small', 'medium', 'large'] as TextScale[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={scale === option}
              onClick={() => {
                setScale(option);
                applyTextScale(option);
              }}
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </section>

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

      <GameWikis />

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

        <h3>Full backup</h3>
        <p className="muted">
          Everything: every title, the original files, how far you have revealed each
          set of hints, and your settings — including this theme and text size. This is
          what to take to a new phone, or to keep before clearing site data.
        </p>
        <label className="toggle toggle-wrap">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand this backup contains hint content for{' '}
            <strong>personal use only</strong> and will not publish or share it.
          </span>
        </label>
        <div className="buttons">
          <button
            type="button"
            disabled={!acknowledged || documents.length === 0}
            onClick={() => void download('backup')}
          >
            Export full backup
          </button>
        </div>

        <h3>Shareable export</h3>
        <p className="muted">
          The subset that carries no redistribution restriction, with no reading
          progress attached. Titles from personal-use-only sources are left out — that
          is every UHS file, and any wiki with a non-commercial licence.
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
            disabled={documents.length === 0}
            onClick={() => void download('shareable')}
          >
            Export shareable copy
          </button>
        </div>

        <h3>Import</h3>
        <p className="muted">
          Restores either kind. Reveal progress is merged upwards, so importing an
          older backup never hides a hint you have already seen.
        </p>
        <div className="buttons">
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import from file
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
                  await refreshFromStorage();
                  const parts = [`Imported ${result.imported} title(s)`];
                  if (result.revealStates > 0) {
                    parts.push(`${result.revealStates} with reading progress`);
                  }
                  if (result.settings + result.preferences > 0) {
                    parts.push(`${result.settings + result.preferences} setting(s)`);
                  }
                  if (result.skipped.length > 0) {
                    parts.push(`skipped ${result.skipped.length}`);
                  }
                  setMessage(`${parts.join(', ')}.`);
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
        <h2>Version</h2>
        {isReleaseBuild(WEB_VERSION) ? (
          <>
            <dl className="versions">
              <dt>This app</dt>
              <dd className="mono">{WEB_VERSION}</dd>
              <dt>Proxy</dt>
              <dd className="mono">
                {update.state.proxyVersion ?? (online ? 'not reachable' : 'offline')}
              </dd>
              {/* What the registry holds, per image, because the two publish
                  independently and can genuinely differ. */}
              {update.state.release?.images.map((image) => (
                <Fragment key={image.name}>
                  <dt>Published {image.name}</dt>
                  {/* A version is mono; a failure is a sentence, and `.mono`
                      does not wrap, so it would run off the side. */}
                  {image.available ? (
                    <dd className="mono">{image.available}</dd>
                  ) : (
                    <dd className="muted">{image.error ?? 'unknown'}</dd>
                  )}
                </Fragment>
              ))}
            </dl>
            {update.state.reason === 'service-worker' && (
              <div className="warnings-box">
                <strong>A new version is ready to install.</strong>
                <p>
                  It is already downloaded. Reloading swaps it in; your library and
                  reading progress are untouched.
                </p>
                <button type="button" onClick={update.apply}>
                  Reload to update
                </button>
              </div>
            )}
            {update.state.reason === 'version-mismatch' && (
              <div className="warnings-box">
                <strong>The app and the proxy are on different builds.</strong>
                <p>
                  Usually one container was updated and the other was not — pull both
                  and restart them. If they already match on the server, this browser is
                  still holding an older copy, and reloading will pick the new one up.
                </p>
                <button type="button" onClick={update.apply}>
                  Reload
                </button>
              </div>
            )}
            {update.state.reason === 'registry-release' && (
              <div className="warnings-box">
                <strong>
                  A newer build has been published: {update.state.release?.version ?? 'unknown'}.
                </strong>
                <p>
                  This one is not in the browser&rsquo;s hands — the images on the host are
                  still the older build, so there is nothing here to reload. Pull them
                  where the stack runs:
                </p>
                <p>
                  <code>docker compose pull &amp;&amp; docker compose up -d</code>
                </p>
                <p className="muted">
                  {update.state.release?.behind.length === 1
                    ? `The ${update.state.release.behind[0]} image is behind.`
                    : 'Both images are behind.'}{' '}
                  {(update.state.release?.unknown.length ?? 0) > 0 && (
                    <>
                      The {update.state.release!.unknown.join(' and ')} image
                      {update.state.release!.unknown.length === 1 ? ' does' : 's do'} not report
                      a version, so nothing was compared for{' '}
                      {update.state.release!.unknown.length === 1 ? 'it' : 'them'}.{' '}
                    </>
                  )}
                  On a Synology, Container Manager &rarr; Registry &rarr; pull{' '}
                  <code>latest</code>, then rebuild the project.
                </p>
              </div>
            )}
            {update.state.reason === null &&
              (update.state.checked ? (
                <p className="muted">Up to date.</p>
              ) : (
                <p className="muted">
                  {online
                    ? 'The proxy has not answered a version check yet, so there is nothing to compare against.'
                    : 'Offline — versions can only be compared with a connection.'}
                </p>
              ))}
            <div className="buttons">
              <button type="button" onClick={() => void update.check()}>
                Check for updates
              </button>
            </div>
          </>
        ) : (
          <p className="muted">
            A development build. Version checks are off — they only mean something
            for images built by the publish workflow.
          </p>
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

/**
 * The wikis this deployment may read.
 *
 * Fandom and wiki.gg between them host hundreds of thousands of wikis about
 * everything, and neither offers a "games only" filter — so this list is the
 * filter, and it is yours. Adding one takes effect immediately: the allowlist
 * lives in the proxy's database, not in the environment, so there is nothing to
 * restart.
 *
 * A host from `WIKI_ALLOWLIST` is shown but cannot be removed here. That is the
 * operator's standing decision, and an app should not be able to quietly undo
 * something somebody put in the environment on purpose.
 */
function GameWikis(): JSX.Element {
  const [wikis, setWikis] = useState<WikiSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await api.allowedWikis();
      setWikis(response.wikis);
      setError(null);
    } catch (caught) {
      setError(
        isOfflineError(caught)
          ? 'The proxy is not reachable, so the wiki list cannot be shown.'
          : (caught as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h2>Game wikis</h2>
      <p className="muted">
        Fandom and wiki.gg host wikis for almost every game, and for a great many things
        that are not games. Nothing from either is searched until you add it here. Pages
        are re-shaped on the way in so answers reveal one at a time, and reference pages —
        stat tables, item lists — are skipped.
      </p>

      {loading && <Spinner label="Loading wikis…" />}
      {error && <ErrorNote error={error} />}

      {!loading && wikis.length === 0 && (
        <p className="muted">No wikis yet. Search for a game below to find one.</p>
      )}

      {wikis.length > 0 && (
        <ul className="list">
          {wikis.map((wiki) => (
            <li className="row" key={wiki.host}>
              <div className="row-main">
                <span className="row-title">{wiki.sitename ?? wiki.host}</span>
                <span className="row-meta">
                  <span className="muted mono">{wiki.host}</span>
                  {wiki.pinned && (
                    <span className="pill" title="From WIKI_ALLOWLIST in the environment.">
                      pinned
                    </span>
                  )}
                </span>
                {wiki.error ? (
                  <span className="error">{wiki.error}</span>
                ) : (
                  <LicenceLine
                    license={wiki.license}
                    personalUseOnly={wiki.personalUseOnly}
                  />
                )}
              </div>
              {!wiki.pinned && (
                <button
                  type="button"
                  className="row-action"
                  onClick={() => {
                    void api
                      .forgetWiki(wiki.host)
                      .then(load)
                      .catch((caught: Error) => setError(caught.message));
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>Add a wiki</h3>
      <p className="muted">
        Type a game&rsquo;s name and it will check the addresses a wiki for it would
        plausibly live at. Neither platform publishes a searchable index, so that is
        guesswork and it does miss things — if you already found the wiki in a browser,
        paste its address instead and it will be checked directly.
      </p>
      <WikiFinder showInput onAdded={() => void load()} />
    </section>
  );
}
