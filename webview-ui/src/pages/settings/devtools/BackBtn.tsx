import React from 'react';

/* ── Shared Back button ── */
export const BackBtn = ({ onClick }: { onClick: () => void }) => (
  <button className="bs-btn-sm bs-btn-secondary" onClick={onClick} style={{ marginRight: 8 }}>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
    Back
  </button>
);
