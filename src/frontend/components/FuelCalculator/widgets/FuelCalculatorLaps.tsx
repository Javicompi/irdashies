import React from 'react';
import { useTotalRaceValue } from '@irdashies/context';
import type { FuelCalculatorSettings, FuelCalculation } from '../types';

interface FuelCalculatorLapsProps {
  fuelData: FuelCalculation | null;
  fuelUnits: 'L' | 'gal';
  settings?: FuelCalculatorSettings;
  widgetId?: string;
  displayData?: FuelCalculation;
  customStyles?: {
    fontSize?: number;
    labelFontSize?: number;
    valueFontSize?: number;
    barFontSize?: number;
  };
  compactMode?: 'off' | 'compact' | 'ultra';
}

/**
 * Color a lap-count value based on how close its fractional part is to a whole
 * lap (the estimate is unstable right at the boundary).
 *  - orange: fraction <= 0.15 or >= 0.85 (very close to flipping a lap)
 *  - yellow: fraction <= 0.30 or >= 0.70 (getting close)
 *  - white:  otherwise (stable)
 */
const getLapColor = (value: number, lapsCompleted: number): string => {
  // Only meaningful once we have a few laps of data.
  if (lapsCompleted < 3) return 'text-white';
  if (value <= 0) return 'text-white';
  const frac = value - Math.floor(value);
  if (frac <= 0.15 || frac >= 0.85) return 'text-orange-400';
  if (frac <= 0.30 || frac >= 0.70) return 'text-yellow-400';
  return 'text-white';
};

export const FuelCalculatorLaps: React.FC<FuelCalculatorLapsProps> = ({
  fuelData,
  settings,
  widgetId,
  customStyles,
  compactMode = 'off',
}) => {
  // Laps completed by the player's car (for the color threshold).
  const playerLaps = fuelData?.currentLap ?? 0;

  // Total race laps projected for the player and the global leader.
  const { totalRaceLaps, leaderRaceLaps } = useTotalRaceValue();

  const widgetStyle =
    customStyles || (widgetId && settings?.widgetStyles?.[widgetId]) || {};
  const labelFontSize = widgetStyle.labelFontSize
    ? `${widgetStyle.labelFontSize}px`
    : widgetStyle.fontSize
      ? `${widgetStyle.fontSize}px`
      : '10px';
  const valueFontSize = widgetStyle.valueFontSize
    ? `${widgetStyle.valueFontSize}px`
    : widgetStyle.fontSize
      ? `${widgetStyle.fontSize}px`
      : '14px';
  // The value row is slightly smaller than the title.
  const rowFontSize = Math.max(8, (parseInt(valueFontSize, 10) || 14) - 2);

  const paddingClass =
    compactMode === 'ultra' ? '' : compactMode === 'compact' ? 'p-1' : 'p-2';

  const showPlayer = totalRaceLaps > 0;
  const showLeader = leaderRaceLaps > 0;
  const playerColor = getLapColor(totalRaceLaps, playerLaps);
  const leaderColor = getLapColor(leaderRaceLaps, playerLaps);

  return (
    <div
      className={`flex flex-col ${paddingClass} ${compactMode !== 'off' ? 'mb-0' : 'mb-1 border-b border-slate-600/50'}`}
    >
      <div className="flex items-center">
        <span
          className="text-white font-semibold tracking-wider"
          style={{ fontSize: labelFontSize }}
        >
          LAPS
        </span>
      </div>
      <div
        className={`flex items-center justify-between ${compactMode !== 'off' ? 'gap-3' : 'gap-6'}`}
        style={{ fontSize: rowFontSize }}
      >
        <span className="text-slate-400">
          You:{' '}
          <span className={`font-bold ${playerColor}`}>
            {showPlayer ? totalRaceLaps.toFixed(1) : '--'}
          </span>
        </span>
        <span className="text-slate-400">
          Leader:{' '}
          <span className={`font-bold ${leaderColor}`}>
            {showLeader ? leaderRaceLaps.toFixed(1) : '--'}
          </span>
        </span>
      </div>
    </div>
  );
};
