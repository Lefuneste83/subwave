'use client';

// Library → Transitions: how many tracks can take each Hot Mix transition,
// for the whole library and per Hot Mix show (the words and the arithmetic:
// transition-readiness-view.ts). Presentational: the read is the tab's
// (tabs/TransitionsTab.tsx), so this renders from props alone.

import { useRef } from 'react';
import { Card } from '../ui';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import type { TransitionReadiness, TransitionTierId } from '../../../lib/schemas.generated';
import {
  SEAM_NOTE, TIER_COPY, computedLine, num, partLabel, partTitle, pct, showRange, showTierCount, showTotal,
} from './transition-readiness-view';

type Show = TransitionReadiness['shows'][number];
type Tier = TransitionReadiness['tiers'][number];

function Bar({ value, of, label }: { value: number; of: number; label: string }) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const share = of ? Math.min(100, (value / of) * 100) : 0;
  useDynamicStyle(fillRef, { width: `${share}%` });
  return (
    <span
      className="lib-minibar !min-w-[56px]"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share)}
    >
      <span ref={fillRef} />
    </span>
  );
}

// One figure line: who it counts for, the bar, the count and its share.
function Figure({ who, title, value, of, extra }: { who: string; title?: string; value: number; of: number; extra?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_6.5rem] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_6.5rem]" title={title}>
      <span className="caption truncate !tracking-[0.04em] !normal-case">{who}</span>
      <Bar value={value} of={of} label={`${who}: ${value} of ${of}`} />
      <span className="mono-num text-right text-[12px] text-ink">
        {num(value)} <span className="text-muted">· {pct(value, of)}</span>
      </span>
      {extra && <span className="caption col-start-2 col-end-4 !tracking-[0.04em] text-muted !normal-case">{extra}</span>}
    </div>
  );
}

function ShowFigure({ show, tier }: { show: Show; tier: TransitionTierId }) {
  const n = showTierCount(show, tier);
  if (n == null) {
    return (
      <div
        className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)]"
        title="These tracks have no tempo a Hot Mix show trusts. The figure is how many would be in this show's range by their stored tempo, which is an estimate: what a beat-grid run might bring in, not what the show can pick today."
      >
        <span className="caption truncate !tracking-[0.04em] !normal-case">{show.name}</span>
        <span className="caption !tracking-[0.04em] text-muted !normal-case">
          never picked · ≈ {num(show.outByStoredTempo)} in range by their untrusted tempo
        </span>
      </div>
    );
  }
  return (
    <Figure
      who={show.name}
      title={`Of the ${num(showTotal(show))} tracks ${show.name} can pick (${showRange(show)}).`}
      value={n}
      of={showTotal(show)}
      extra={tier === 'phrase' && !show.phraseMix ? 'phrase mix off in this show: these air as beat mixes' : undefined}
    />
  );
}

function TierBlock({ tier, library, shows }: { tier: Tier; library: number; shows: Show[] }) {
  const copy = TIER_COPY[tier.tier];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-dashed border-[var(--separator-strong)] px-4 py-3.5 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-w-0">
        <div className="text-sm font-bold text-ink">{copy.name}</div>
        <p className="mt-1 text-[12px] leading-snug text-muted">{copy.hears}</p>
        {tier.parts.length > 0 && (
          <ul className="mt-2 grid gap-0.5">
            {tier.parts.map(p => (
              <li key={`${p.part}:${p.reason ?? ''}`} className="caption flex gap-2 !tracking-[0.04em] !normal-case" title={partTitle(p.part)}>
                <span className="mono-num w-14 shrink-0 text-right text-ink">{num(p.tracks)}</span>
                <span className="min-w-0">{partLabel(p.part, p.reason)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid min-w-0 content-start gap-2">
        <Figure
          who="All tracks"
          value={tier.tracks}
          of={library}
          extra={tier.tracks ? `${num(tier.stems)} with stems saved` : undefined}
        />
        {shows.map(s => <ShowFigure key={s.id} show={s} tier={tier.tier} />)}
      </div>
    </div>
  );
}

export default function TransitionsView({ readiness: r, now }: { readiness: TransitionReadiness | null; now?: number }) {
  return (
    <Card
      title="Hot Mix transitions"
      sub={SEAM_NOTE}
      bodyClass="!p-0"
    >
      {!r ? (
        <div className="grid gap-2 p-4">
          <span className="caption !tracking-[0.04em] !normal-case">Counting the library… the first count takes a few seconds.</span>
          <SkeletonRows rows={4} />
        </div>
      ) : (
        <>
          <div className="grid gap-1 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5">
            {r.shows.length === 0 ? (
              <span className="caption !tracking-[0.04em] !normal-case">
                No show has Hot Mix on, so only the whole library is shown. Turn Hot Mix on in a show to see what its tempo range can reach.
              </span>
            ) : (
              r.shows.map(s => (
                <span key={s.id} className="caption !tracking-[0.04em] !normal-case">
                  <span className="font-bold text-ink">{s.name}</span>
                  {' '}· {showRange(s)} · phrase mix {s.phraseMix ? 'on' : 'off'} · {num(showTotal(s))} tracks it can pick, the base of its shares
                </span>
              ))
            )}
            <span className="caption !tracking-[0.04em] text-muted !normal-case">{computedLine(r, now)}</span>
          </div>
          {r.tiers.map(t => <TierBlock key={t.tier} tier={t} library={r.library} shows={r.shows} />)}
        </>
      )}
    </Card>
  );
}
