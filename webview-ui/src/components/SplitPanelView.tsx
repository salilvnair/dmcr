/**
 * Resizable split-panel layout — ported from ck8t/daakia.
 * Horizontal or vertical, draggable handle, double-click to reset.
 */
import React, { useState, useRef, useEffect } from 'react';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

interface SplitPanelViewProps {
  direction?: 'horizontal' | 'vertical';
  first: React.ReactNode;
  second: React.ReactNode;
  defaultSplit?: number;
  split?: number;
  minFirst?: number;
  minSecond?: number;
  accentColor?: string;
  onResize?: (pct: number) => void;
  onResizeEnd?: (pct: number) => void;
  pillTooltip?: React.ReactNode | null;
  style?: React.CSSProperties;
  className?: string;
}

export function SplitPanelView({
  direction = 'horizontal',
  first,
  second,
  defaultSplit = 50,
  split: splitProp,
  minFirst = 80,
  minSecond = 80,
  accentColor,
  onResize,
  onResizeEnd,
  pillTooltip,
  style,
  className = '',
}: SplitPanelViewProps) {
  const [internalSplit, setInternalSplit] = useState(splitProp ?? defaultSplit);
  const [dragging, setDragging]           = useState(false);
  const [hovered, setHovered]             = useState(false);
  const containerRef  = useRef<HTMLDivElement>(null);
  const dragActiveRef = useRef(false);
  const hasMovedRef   = useRef(false);
  const isHoriz = direction === 'horizontal';
  const accent  = accentColor || 'var(--bs-accent, #818cf8)';
  const pillActive = dragging || hovered;

  useEffect(() => {
    if (splitProp !== undefined) setInternalSplit(splitProp);
  }, [splitProp]);

  const currentSplit = splitProp !== undefined ? splitProp : internalSplit;

  function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragActiveRef.current = true;
    hasMovedRef.current   = false;
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragActiveRef.current || !containerRef.current) return;
    hasMovedRef.current = true;
    const rect  = containerRef.current.getBoundingClientRect();
    const total = isHoriz ? rect.width : rect.height;
    const pos   = isHoriz ? e.clientX - rect.left : e.clientY - rect.top;
    const pct   = Math.max(
      (minFirst  / total) * 100,
      Math.min((1 - minSecond / total) * 100, (pos / total) * 100),
    );
    setInternalSplit(pct);
    onResize?.(pct);
  }

  function handlePointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragActiveRef.current = false;
    setDragging(false);
    if (hasMovedRef.current) onResizeEnd?.(internalSplit);
  }

  function handleDoubleClick() {
    setInternalSplit(defaultSplit);
    onResize?.(defaultSplit);
    onResizeEnd?.(defaultSplit);
  }

  const firstStyle: React.CSSProperties = isHoriz
    ? { width: `${currentSplit}%`, minWidth: minFirst, height: '100%', overflow: 'hidden',
        transition: dragging ? 'none' : `width 180ms ${EASE}` }
    : { height: `${currentSplit}%`, minHeight: minFirst, width: '100%', overflow: 'hidden',
        transition: dragging ? 'none' : `height 180ms ${EASE}` };

  const secondStyle: React.CSSProperties = isHoriz
    ? { flex: 1, minWidth: minSecond, height: '100%', overflow: 'hidden' }
    : { flex: 1, minHeight: minSecond, width: '100%', overflow: 'hidden',
        transition: dragging ? 'none' : `all 180ms ${EASE}` };

  const pillW = isHoriz ? 3 : (pillActive ? 72 : 36);
  const pillH = isHoriz ? (pillActive ? 72 : 36) : 3;

  const resolvedTooltip = pillTooltip === undefined ? (
    <div style={{ fontSize: 11, lineHeight: 1.7 }}>
      <div>Drag to resize</div>
      <div style={{ opacity: 0.65 }}>Double-click to reset</div>
    </div>
  ) : pillTooltip;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ display: 'flex', flexDirection: isHoriz ? 'row' : 'column',
               width: '100%', height: '100%', overflow: 'hidden', ...style }}
    >
      <div style={firstStyle}>{first}</div>

      {/* Drag handle */}
      <div
        style={{
          flexShrink: 0,
          width:  isHoriz ? 6 : '100%',
          height: isHoriz ? '100%' : 6,
          cursor: isHoriz ? 'col-resize' : 'row-resize',
          position: 'relative',
          userSelect: 'none',
          background: 'rgba(255,255,255,0.03)',
          zIndex: 10,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDoubleClick={handleDoubleClick}
        aria-label="Resize panels"
      >
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: pillW, height: pillH,
          borderRadius: 9999,
          background: pillActive ? accent : 'rgba(255,255,255,0.14)',
          transition: `${isHoriz ? 'height' : 'width'} 150ms ease, background 150ms ease`,
          pointerEvents: 'none',
        }} />
        {resolvedTooltip != null && hovered && !dragging && (
          <div style={{
            position: 'absolute',
            ...(isHoriz
              ? { left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' }
              : { left: '50%', top: 'calc(100% + 6px)', transform: 'translateX(-50%)' }),
            background: '#12121e',
            color: '#e2e8f0',
            fontSize: 11, lineHeight: 1.7,
            padding: '6px 10px', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 9999,
          }}>
            {resolvedTooltip}
          </div>
        )}
      </div>

      <div style={secondStyle}>{second}</div>
    </div>
  );
}
