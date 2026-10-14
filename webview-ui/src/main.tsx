import React from 'react';
import ReactDOM from 'react-dom/client';
import { DuiProvider } from '@salilvnair/dui';
import '@salilvnair/dui/monaco-setup';
import '@salilvnair/dui/style.css';
import './index.css';
import App from './App';
import { warmMonacoLanguages } from './utils/warmMonacoLanguages';

import { paint as paintTheme } from './services/theme/apply';
// the saved palette and terminal theme, before the first render (no flash of the default colours)
paintTheme();

document.documentElement.setAttribute('data-theme', 'dark');

// fetch the SQL / JSON highlighters now, so the first editor opened is coloured at once (not plain text first)
warmMonacoLanguages();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* One control size across DMCR: every dui input, select and button is 28px tall */}
    <DuiProvider size="md">
      <App />
    </DuiProvider>
  </React.StrictMode>,
);
