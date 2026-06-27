import { useState, useEffect, useCallback, useRef } from 'react';

export type ContextMenuItem = {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
};

type Position = { x: number; y: number };

let globalHide: (() => void) | null = null;

/**
 * Hook that returns a trigger function and a rendered menu.
 * Call `show(e)` from an onContextMenu handler.
 */
export function useContextMenu(items: ContextMenuItem[]) {
  const [pos, setPos] = useState<Position | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const show = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Hide any other open context menu
    if (globalHide) globalHide();
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (pos) {
      globalHide = hide;
      const onClose = () => hide();
      window.addEventListener('click', onClose);
      window.addEventListener('contextmenu', onClose);
      window.addEventListener('scroll', onClose, true);
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
      return () => {
        window.removeEventListener('click', onClose);
        window.removeEventListener('contextmenu', onClose);
        window.removeEventListener('scroll', onClose, true);
        if (globalHide === hide) globalHide = null;
      };
    }
  }, [pos, hide]);

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (pos && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let { x, y } = pos;
      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      if (x !== pos.x || y !== pos.y) setPos({ x, y });
    }
  }, [pos]);

  const menu = pos ? (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={e => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="ctx-menu-item"
          disabled={item.disabled}
          onClick={() => { hide(); item.onClick(); }}
        >
          {item.icon && <span className="ctx-menu-icon">{item.icon}</span>}
          <span className="ctx-menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  return { show, menu, visible: !!pos };
}
