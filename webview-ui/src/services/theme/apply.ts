/**
 * Putting a palette on the page: one <style id="dmcr-palette"> appended last to <head>, so it wins
 * over index.css without a more specific selector. DMCR's own palette removes it (the stylesheet as it ships).
 */
import { paletteCss, findPalette, DEFAULT_PALETTE_ID } from './palette';

const ELEMENT_ID = 'dmcr-palette';
const STORAGE_KEY = 'dmcr.palette';

let currentId = readStored();

function readStored(): string {
  try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_PALETTE_ID; } catch { return DEFAULT_PALETTE_ID; }
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const el = document.createElement('style');
  el.id = ELEMENT_ID;
  document.head.appendChild(el);
  return el;
}

/** The selected palette id. */
export function currentPaletteId(): string { return currentId; }

/** Select a palette (remembered) and paint it for a mode. */
export function selectPalette(id: string, mode: 'dark' | 'light'): void {
  currentId = findPalette(id).id;
  try { localStorage.setItem(STORAGE_KEY, currentId); } catch { /* storage blocked: still applied */ }
  repaintPalette(mode);
}

/** Paint the selected palette for a mode (call again when dark / light changes). */
export function repaintPalette(mode: 'dark' | 'light'): void {
  if (currentId === DEFAULT_PALETTE_ID) { document.getElementById(ELEMENT_ID)?.remove(); return; }
  styleElement().textContent = paletteCss(findPalette(currentId), mode);
}
