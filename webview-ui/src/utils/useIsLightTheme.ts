import { useEffect, useState } from 'react';

/** True while the app is in light mode (<html data-theme="light">); follows the theme toggle. */
export function useIsLightTheme(): boolean {
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === 'light');
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setLight(root.dataset.theme === 'light');
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
    return () => obs.disconnect();
  }, []);
  return light;
}
