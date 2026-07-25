import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';

import { App } from './ui/App';
import { Browse } from './ui/Browse';
import { Library } from './ui/Library';
import { Reader } from './ui/Reader';
import { Search } from './ui/Search';
import { Settings } from './ui/Settings';
import { initTheme } from './ui/themes';
import { startUpdateWatch } from './ui/update';
import './ui/styles.css';

// Before the first paint, so launching never flashes the wrong theme.
initTheme();

// Registers the service worker — which is what makes the app work offline at
// all — and starts watching for a newer build.
startUpdateWatch();

/**
 * A hash router, deliberately.
 *
 * The app has to cold-launch from the home screen with no network at all. A
 * hash route never asks the server for a path, so deep links keep working in
 * airplane mode even if the service worker's navigation fallback misbehaves.
 */
const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Library /> },
      { path: 'search', element: <Search /> },
      { path: 'browse', element: <Browse /> },
      { path: 'browse/:source', element: <Browse /> },
      { path: 'read/:id', element: <Reader /> },
      { path: 'read/:id/:nodeId', element: <Reader /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
