'use client';

// DJ Hot Mix for one show: the switch, the tempo step, the overlap length, the
// BPM curve over the show's running time, and the requests toggle. The phrase
// mix (`phraseMix`) has no control yet: the form carries it through untouched. What the switch does on air is
// the controller's music/hot-mix-policy.ts; this only edits the saved block.

import type { ChangeEvent } from 'react';
import { useId } from 'react';
import { useController, useWatch, type Control } from 'react-hook-form';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { FieldDescription, FieldError } from '../../ui/field';
import { Btn } from '../ui';
import { ShowFieldHelp } from './ShowEditorLayout';
import { fieldAria } from '@/lib/form';
import { SelectField, SwitchField } from '@/lib/form-fields';
import {
  HOT_MIX_BPM_MAX,
  HOT_MIX_BPM_MIN,
  HOT_MIX_CURVE_POINTS_MAX,
  HOT_MIX_PHRASE_BARS,
  HOT_MIX_STEP_PCT_MAX,
  HOT_MIX_STEP_PCT_MIN,
  type HotMixCurvePoint,
} from '@/lib/schemas.generated';
import type { ShowsFormValues } from './types';

// The overlap lengths the schema accepts, as select options.
export const PHRASE_BAR_OPTIONS = HOT_MIX_PHRASE_BARS.map(n => ({ value: String(n), label: `${n} bars` }));

// A new point lands after the last one, halfway to the end, at its tempo.
export function nextCurvePoint(curve: readonly HotMixCurvePoint[]): HotMixCurvePoint {
  const last = [...curve].sort((a, b) => a.at - b.at).at(-1);
  if (!last) return { at: 0, bpm: 124 };
  return { at: Math.min(100, Math.round(last.at + (100 - last.at) / 2)), bpm: last.bpm };
}

// The number an input holds, or the raw text while it is being typed: the
// schema reads numeric strings, and refusing a half-typed value would fight
// the operator.
const numberOrText = (raw: string): number | string => {
  const t = raw.trim();
  if (t === '') return '';
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
};

export function HotMixFields({ control, index }: { control: Control<ShowsFormValues>; index: number }) {
  const uid = useId();
  const base = `shows.${index}.hotMix` as const;
  const enabled = useWatch({ control, name: `${base}.enabled` }) === true;
  const stepCtl = useController({ control, name: `${base}.maxStepPct` });
  const curveCtl = useController({ control, name: `${base}.curve` });
  const stepAria = fieldAria(`${uid}-step`, stepCtl.fieldState.error, { hasDescription: true });
  const curveAria = fieldAria(`${uid}-curve`, curveCtl.fieldState.error, { hasDescription: true });
  const curve: HotMixCurvePoint[] = Array.isArray(curveCtl.field.value) ? curveCtl.field.value : [];

  const setPoint = (i: number, key: keyof HotMixCurvePoint, raw: string) => {
    const next = curve.map((p, j) => (j === i ? { ...p, [key]: numberOrText(raw) } : p));
    curveCtl.field.onChange(next);
  };
  // A bad point's own error sits on its path (curve.0.bpm) and reaches the
  // editor's error summary; this shows the list-level ones (too many points).
  const curveErrors = curveCtl.fieldState.error?.message ? [curveCtl.fieldState.error] : undefined;

  return (
    <div className="grid gap-5">
      <SwitchField
        control={control}
        name={`${base}.enabled`}
        label="DJ Hot Mix"
        description="Mixes this show like a DJ set: each track the DJ picks stays close in tempo to the one before it, and the mixer beat-matches each transition. Meant for electronic shows."
      />
      <ShowFieldHelp title="How the transitions are mixed">
        The incoming track starts on a downbeat, on a downbeat of the outgoing one, and both play together for the
        overlap below (eight bars unless you change it). Up to the step, only the incoming track is synced and the outgoing one plays untouched; up to twice the
        step, both meet halfway; past that, and for any track without a measured beat grid, it is a plain crossfade.
        The incoming track then glides back to its own tempo. The first show to turn Hot Mix on (or the last to turn
        it off) needs a mixer restart: Settings, then restart mixer.
      </ShowFieldHelp>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="field">
          <Label {...stepAria.labelProps}>max tempo step (%)</Label>
          <Input
            {...stepAria.controlProps}
            type="number"
            min={HOT_MIX_STEP_PCT_MIN}
            max={HOT_MIX_STEP_PCT_MAX}
            step={0.5}
            disabled={!enabled}
            value={stepCtl.field.value ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => stepCtl.field.onChange(numberOrText(e.target.value))}
            onBlur={stepCtl.field.onBlur}
            ref={stepCtl.field.ref}
          />
          <FieldDescription {...stepAria.descriptionProps}>
            How far the tempo may move from one track to the next, between {HOT_MIX_STEP_PCT_MIN} and{' '}
            {HOT_MIX_STEP_PCT_MAX} %. Half and double time count as the same tempo (64 BPM sits next to 128).
          </FieldDescription>
          <ShowFieldHelp title="When nothing fits">
            The DJ only sees tracks inside the step. If the library has nothing there, the station takes the
            nearest tempo it has, preferring a compatible key, and the booth log says so. Tracks with no measured tempo
            are left out of a mixed show. Anything you queue yourself still plays.
          </ShowFieldHelp>
          <FieldError {...stepAria.errorProps} errors={stepCtl.fieldState.error ? [stepCtl.fieldState.error] : undefined} />
        </div>

        <SelectField
          control={control}
          name={`${base}.phraseBars`}
          label="overlap (bars)"
          disabled={!enabled}
          options={PHRASE_BAR_OPTIONS}
          description="Overlap of each beat mix, in bars; 8 is the norm, 16 suits radio."
        />

        <SwitchField
          control={control}
          name={`${base}.closeRequests`}
          label="No listener requests"
          disabled={!enabled}
          description="Closes listener requests while this show is on air: a request is usually a tempo jump that breaks the mix. Turn off to keep them open; the DJ's own picks still follow the step."
        />
      </div>

      <div className="field">
        <Label {...curveAria.labelledByProps}>tempo curve (optional)</Label>
        <div {...curveAria.groupProps} className="grid gap-2">
          {curve.length === 0 && (
            <p className="text-sm text-muted-foreground">No curve: the tempo wanders freely within the step.</p>
          )}
          {curve.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={`point ${i + 1} position (% of the show)`}
                className="w-20"
                type="number"
                min={0}
                max={100}
                disabled={!enabled}
                value={p.at ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPoint(i, 'at', e.target.value)}
              />
              <span className="text-sm text-muted-foreground">% at</span>
              <Input
                aria-label={`point ${i + 1} tempo (BPM)`}
                className="w-20"
                type="number"
                min={HOT_MIX_BPM_MIN}
                max={HOT_MIX_BPM_MAX}
                disabled={!enabled}
                value={p.bpm ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPoint(i, 'bpm', e.target.value)}
              />
              <span className="text-sm text-muted-foreground">BPM</span>
              <Btn
                sm
                aria-label={`remove point ${i + 1}`}
                disabled={!enabled}
                onClick={() => curveCtl.field.onChange(curve.filter((_, j) => j !== i))}
              >
                Remove
              </Btn>
            </div>
          ))}
          <div>
            <Btn
              sm
              disabled={!enabled || curve.length >= HOT_MIX_CURVE_POINTS_MAX}
              onClick={() => curveCtl.field.onChange([...curve, nextCurvePoint(curve)])}
            >
              Add point
            </Btn>
          </div>
        </div>
        <FieldDescription {...curveAria.descriptionProps}>
          A few points over the show&apos;s running time, each a position in % of the show and a tempo, e.g. 0 % at 118, 50 % at 128, 100 % at 122 (up to{' '}
          {HOT_MIX_CURVE_POINTS_MAX}). The set follows it one step at a time: the curve says which way to move, the
          step still limits how far.
        </FieldDescription>
        <FieldError {...curveAria.errorProps} errors={curveErrors} />
      </div>
    </div>
  );
}
