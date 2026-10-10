import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import SchemaExplorerPage from './pages/SchemaExplorerPage';

import { paint as paintTheme } from './services/theme/apply';
// the saved palette and terminal theme, before the first render (no flash of the default colours)
paintTheme();

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SchemaExplorerPage />
  </React.StrictMode>,
);
