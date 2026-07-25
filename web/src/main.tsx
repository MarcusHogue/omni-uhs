import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';

import { App } from './ui/App';
import { Browse } from './ui/Browse';
import { Library } from './ui/Library';
import { Reader } from './ui/Reader';
import { Search } from './ui/Search';
import { Settings } from './ui/Settings';
import './ui/styles.css';

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
