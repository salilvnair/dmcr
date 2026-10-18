import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import SchemaExplorerPage from './pages/SchemaExplorerPage';
import { LoadGate } from './components/PageLoader';
import { DatabaseTableIcon } from '@salilvnair/dui';

import { paint as paintTheme } from './services/theme/apply';
// the saved palette and terminal theme, before the first render (no flash of the default colours)
paintTheme();

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LoadGate wait={['dbMcpServers']} icon={<DatabaseTableIcon />} title="Reading the database servers"><SchemaExplorerPage /></LoadGate>
  </React.StrictMode>,
);
