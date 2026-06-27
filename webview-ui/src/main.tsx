import React from 'react';
import ReactDOM from 'react-dom/client';
import '@salilvnair/dui/monaco-setup';
import '@salilvnair/dui/style.css';
import './index.css';
import App from './App';

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
