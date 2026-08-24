/* Hallmark pre-emit critique: P5 H5 E5 S5 R5 V4 */

import { createContext, useContext } from 'react';

export type TuiDensity = 'compact' | 'tight';

export interface DensityMetrics {
  panelMarginY: 0;
  turnMarginY: 0;
  userPaddingX: 1;
  userPaddingY: 0;
  headingGapBefore: 0 | 1;
  majorBlockGap: 0 | 1;
  /** Blank rows between consecutive tool rows. Zero: they read as one column. */
  toolRowGap: 0 | 1;
  /** Blank rows between prose and the tool block that follows it. */
  toolBlockGap: 0 | 1;
  paragraphGap: 1;
  showOptionalHelp: boolean;
}

const COMPACT_METRICS: DensityMetrics = {
  panelMarginY: 0,
  turnMarginY: 0,
  userPaddingX: 1,
  userPaddingY: 0,
  headingGapBefore: 1,
  majorBlockGap: 1,
  toolRowGap: 0,
  toolBlockGap: 1,
  paragraphGap: 1,
  showOptionalHelp: true,
};

const TIGHT_METRICS: DensityMetrics = {
  ...COMPACT_METRICS,
  headingGapBefore: 0,
  majorBlockGap: 0,
  toolRowGap: 0,
  toolBlockGap: 0,
  showOptionalHelp: false,
};

export const DensityContext = createContext<TuiDensity>('compact');

export function resolveTuiDensity(rows: number): TuiDensity {
  return Math.floor(rows) < 18 ? 'tight' : 'compact';
}

export function densityMetrics(density: TuiDensity): DensityMetrics {
  return density === 'tight' ? TIGHT_METRICS : COMPACT_METRICS;
}

export function useDensity(): TuiDensity {
  return useContext(DensityContext);
}

export function useDensityMetrics(): DensityMetrics {
  return densityMetrics(useDensity());
}
