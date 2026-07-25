import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { getSetting, requestPersistence, setSetting } from '../storage/db';
import { useOnline } from './hooks';

/**
 * App shell: a tab bar and an offline indicator.
 *
 * The install tip is not decoration. On iOS, an installed (Add to Home Screen)
 * web app is exempt from Safari's 7-day unused-storage eviction; a browser tab
 * is not, and a library that quietly evicts itself would defeat the point.
 */
export function App(): JSX.Element {
  const online = useOnline();
  const [showInstallTip, setShowInstallTip] = useState(false);
  const location = useLocation();

  useEffect(() => {
    void (async () => {
      const dismissed = await getSetting('installTipDismissed', false);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as { standalone?: boolean }).standalone === true;
      setShowInstallTip(!dismissed && !standalone);
      // Ask for durable storage as early as possible.
      await requestPersistence();
    })();
  }, []);

  const inReader = location.pathname.startsWith('/read/');

  return (
    <div className="app">
      <header className="app-header">
        <h1>Hint Reader</h1>
        {!online && (
          <span className="pill pill-offline" title="Reading works offline">
            Offline
          </span>
        )}
      </header>

      {showInstallTip && (
        <div className="tip" role="note">
          <p>
            <strong>Add to Home Screen</strong> to keep your library. Installed web apps
            are exempt from Safari&rsquo;s 7-day storage eviction; a browser tab is not.
          </p>
          <button
            type="button"
            onClick={() => {
              setShowInstallTip(false);
              void setSetting('installTipDismissed', true);
            }}
          >
            Got it
          </button>
        </div>
      )}

      <main className={inReader ? 'app-main app-main-reader' : 'app-main'}>
        <Outlet />
      </main>

      <nav className="tabbar">
        <NavLink to="/" end>
          Library
        </NavLink>
        <NavLink to="/search">Search</NavLink>
        <NavLink to="/browse">Browse</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
    </div>
  );
}
