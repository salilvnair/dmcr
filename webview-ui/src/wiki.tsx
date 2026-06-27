import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { WikiPanel } from './pages/settings/WikiPanel';

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WikiPanel sidebar />
  </React.StrictMode>,
);
