import React from 'react';
import ReactDOM from 'react-dom/client';
import { DuiProvider } from '@salilvnair/dui';
import '@salilvnair/dui/monaco-setup';
import '@salilvnair/dui/style.css';
import './index.css';
import App from './App';

import { paint as paintTheme } from './services/theme/apply';
// the saved palette and terminal theme, before the first render (no flash of the default colours)
paintTheme();

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* One control size across DMCR: every dui input, select and button is 28px tall */}
    <DuiProvider size="md">
      <App />
    </DuiProvider>
  </React.StrictMode>,
);
