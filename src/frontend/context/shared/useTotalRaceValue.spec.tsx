import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionTimingStore } from '../SessionTimingStore/SessionTimingStore';
import { useTotalRaceValue } from './useTotalRaceValue';

// The projection itself is covered by
// src/shared/race-projection/calculateRaceProjection.spec.ts and
// src/app/processors/SessionTimingProcessor.spec.ts. This hook is a thin
// selector over the session-timing channel store.
describe('useTotalRaceValue', () => {
  it('selects the canonical channel values from the session timing store', () => {
    useSessionTimingStore.setState({
      sessionType: 'Race',
      state: 4,
      currentLap: 53,
      totalLaps: 0,
      time: 7000,
      timeTotal: 7200,
      timeRemaining: 200,
      greenFlagTimestamp: 0,
      isFixedLapRace: false,
      totalRaceLaps: 53.7,
      leaderRaceLaps: 62.0,
      totalRaceTime: 7200,
      adjustedRaceTime: 0,
    });
    const { result } = renderHook(() => useTotalRaceValue());
    expect(result.current).toEqual({
      isFixedLapRace: false,
      totalRaceLaps: 53.7,
      totalRaceTime: 7200,
      adjustedRaceTime: 0,
      leaderRaceLaps: 62.0,
    });
  });
});
