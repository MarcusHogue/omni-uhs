import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { getSetting, requestPersistence, setSetting } from '../storage/db';
import { useChromeVisibility, useOnline } from './hooks';

/**
 * App shell.
 *
 * The chrome is deliberately thin and self-effacing: one line of header, one
 * row of tabs, and both slide away the moment you scroll into a hint. The
 * intent is that once you are reading, it is you and the text.
 */
export function App(): JSX.Element {
  const online = useOnline();
  const chromeVisible = useChromeVisibility();
  const [showInstallTip, setShowInstallTip] = useState(false);
  const location = useLocation();
  const atLibrary = location.pathname === '/';

  useEffect(() => {
    void (async () => {
      const dismissed = await getSetting('installTipDismissed', false);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as { standalone?: boolean }).standalone === true;
      setShowInstallTip(!dismissed && !standalone);
      await requestPersistence();
    })();
  }, []);

  return (
    <div className={chromeVisible ? 'app' : 'app chrome-hidden'}>
      <header className="app-header">
        <h1>
          <span className="wordmark">Omni</span> UHS
        </h1>
        {!online && (
          <span className="pill pill-offline" title="Everything downloaded still works">
            Offline
          </span>
        )}
      </header>

      <main className="app-main">
        {/*
          The install tip only appears on the Library screen. It matters — an
          installed iOS web app is exempt from Safari's 7-day storage eviction —
          but not enough to sit above every screen forever.
        */}
        {showInstallTip && atLibrary && (
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
