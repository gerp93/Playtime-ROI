import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './themes.css';
import './index.css';
import App from './App';
import { applyTheme, DEFAULT_THEME, getStoredTheme } from './utils/themes';

applyTheme(getStoredTheme() ?? DEFAULT_THEME);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
