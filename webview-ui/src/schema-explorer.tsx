import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import SchemaExplorerPage from './pages/SchemaExplorerPage';

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SchemaExplorerPage />
  </React.StrictMode>,
);
