'use client';

// The beat grid and structure coverage rows in the Library tagging panel's
// acoustic analysis block (wording and gate: beat-grid-coverage.ts). Same
// layout as the sounds-like and vocal rows above them; no controls, since a
// regular run measures them on its own while a show has Hot Mix on.

import { useRef } from 'react';
import { Activity } from 'lucide-react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import type { BeatGridRow } from './beat-grid-coverage';

function Row({ row }: { row: BeatGridRow }) {
  const fillRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(fillRef, { width: row.pct != null ? `${Math.min(100, row.pct)}%` : '0%' });
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong pt-3">
      <span className="caption flex items-center gap-2">
        <Activity size={13} /> {row.label}
      </span>
      <span className="lib-opt-tag">optional</span>
      <span
        className="lib-minibar"
        role="progressbar"
        aria-label={`${row.label} coverage`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(row.pct != null ? { 'aria-valuenow': Math.min(100, row.pct) } : {})}
      >
        <span ref={fillRef} />
      </span>
      <span className="caption mono-num min-w-0 !tracking-[0.04em] break-words">
        {row.status}
      </span>
      <span className="caption basis-full !tracking-[0.04em] !normal-case">{row.hint}</span>
    </div>
  );
}

export default function BeatGridRows({ rows }: { rows: BeatGridRow[] }) {
  return (
    <>
      {rows.map(r => (
        <Row key={r.key} row={r} />
      ))}
    </>
  );
}
