import React from 'react';
import { ButtonView, ArrowLeftIcon } from '@salilvnair/dui';

/* ── Shared Back button ── */
export const BackBtn = ({ onClick }: { onClick: () => void }) => (
  <ButtonView size="sm" variant="ghost" iconLeft={<ArrowLeftIcon size={13} />} label="Back" onClick={onClick} style={{ marginRight: 8 }} />
);
