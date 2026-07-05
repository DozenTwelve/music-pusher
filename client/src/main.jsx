import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider } from './components/Toast.jsx';
import './index.css';
import './styles.css';

// Apply the saved (or system) theme before first paint to avoid a flash.
const savedTheme = localStorage.getItem('theme');
const initialTheme =
  savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = initialTheme;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
);
