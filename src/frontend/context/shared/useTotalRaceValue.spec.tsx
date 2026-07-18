import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SessionState } from '@irdashies/types';

// Mock the context hooks used by useTotalRaceValue
vi.mock('@irdashies/context', () => ({
  useFocusCarIdx: vi.fn(),
  useCurrentSessionType: vi.fn(),
  useTelemetryValue: vi.fn(),
  useTelemetryValues: vi.fn(),
  useTelemetryValuesRounded: vi.fn(),
  useCarIdxClassEstLapTime: vi.fn(),
}));

vi.mock('../../components/Standings/hooks/useSessionLapCount', () => ({
  useSessionLapCount: vi.fn(),
}));

vi.mock('./useCarIdxAverageLapTime', () => ({
  useCarIdxAverageLapTime: vi.fn(),
}));

// Import after mocks are in place
import { useTotalRaceValue } from './useTotalRaceValue';
import {
  useFocusCarIdx,
  useCurrentSessionType,
  useTelemetryValue,
  useTelemetryValues,
  useTelemetryValuesRounded,
  useCarIdxClassEstLapTime,
} from '@irdashies/context';
import { useSessionLapCount } from '../../components/Standings/hooks/useSessionLapCount';
import { useCarIdxAverageLapTime } from './useCarIdxAverageLapTime';

const PLAYER_CAR_IDX = 0;

interface Scenario {
  lap: number;
  lapDistPct: number;
  leaderLap: number;
  leaderLapDistPct: number;
  avgLapTimeLeader: number;
  avgLapTimePlayer: number;
  sessionTimeRemain: number;
  sessionTimeTotal: number;
  sessionLaps: number;
}

function applyScenario(s: Scenario) {
  // CarIdxLap: leader on lap s.leaderLap, player on lap s.lap
  const carIdxLap = [s.lap, s.leaderLap];
  // CarIdxPosition: leader is P1, player is P2
  const carIdxPosition = [2, 1];
  // CarIdxLapDistPct (rounded by useTelemetryValuesRounded)
  const carIdxLapDistPct = [s.lapDistPct, s.leaderLapDistPct];
  // CarIdxBestLapTime: leader's best
  const carIdxBestLapTime = [-1, s.avgLapTimeLeader];

  vi.mocked(useFocusCarIdx).mockReturnValue(PLAYER_CAR_IDX);
  vi.mocked(useCurrentSessionType).mockReturnValue('Race');
  vi.mocked(useTelemetryValue).mockImplementation((key: string) => {
    if (key === 'Lap') return s.lap;
    if (key === 'LapDistPct') return s.lapDistPct;
    return undefined as never;
  });
  vi.mocked(useTelemetryValues).mockImplementation((key: string) => {
    if (key === 'CarIdxLap') return carIdxLap;
    if (key === 'CarIdxPosition') return carIdxPosition;
    if (key === 'CarIdxBestLapTime') return carIdxBestLapTime;
    return undefined as never;
  });
  vi.mocked(useTelemetryValuesRounded).mockReturnValue(carIdxLapDistPct);
  vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
  vi.mocked(useCarIdxAverageLapTime).mockReturnValue([
    s.avgLapTimePlayer,
    s.avgLapTimeLeader,
  ]);
  vi.mocked(useSessionLapCount).mockReturnValue({
    state: SessionState.Racing,
    currentLap: s.lap,
    totalLaps: s.sessionLaps,
    time: 0,
    timeTotal: s.sessionTimeTotal,
    timeRemaining: s.sessionTimeRemain,
    greenFlagTimestamp: 0,
  });
}

describe('useTotalRaceValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('timed race (time-limited)', () => {
    const baseScenario: Scenario = {
      lap: 14,
      lapDistPct: 0.5,
      leaderLap: 15,
      leaderLapDistPct: 0.5,
      avgLapTimeLeader: 105, // LMP3
      avgLapTimePlayer: 120, // GT4
      sessionTimeRemain: 300,
      sessionTimeTotal: 1800,
      sessionLaps: 32767, // iRacing sentinel for "unlimited" (timed race)
    };

    it('multi-class: subtracts 1 lap when leader is exactly +1 CarIdxLap and physically ahead', () => {
      // Leader on lap 15 at 50%, player on lap 14 at 50%.
      // Real distance advantage = 1.0 lap → should subtract 1.
      // Buggy code did NOT subtract here (leaderLap > lap + 1 is false).
      applyScenario(baseScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base estimate: 300/105 + (15-1) + 0.5 = 2.857 + 14.5 = 17.357
      // Fix subtracts 1 lap (advantage 1.0) → 16.357
      expect(total).toBeCloseTo(16.357, 2);
    });

    it('multi-class: subtracts 2 laps when leader is +2 CarIdxLap ahead', () => {
      // Sanity: the previously-working case (leaderLap > lap + 1) must still work.
      applyScenario({
        ...baseScenario,
        leaderLap: 16,
        leaderLapDistPct: 0.5,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base: 300/105 + (16-1) + 0.5 = 2.857 + 15.5 = 18.357
      // Advantage = (16 + 0.5) - (14 + 0.5) = 2.0 → subtract 2 → 16.357
      expect(total).toBeCloseTo(16.357, 2);
    });

    it('single-class regression: does NOT subtract when leader just crossed S/F', () => {
      // Leader on lap 15 at 0% (just crossed the line), player on lap 14 at 70%.
      // Real distance advantage = (15 + 0) - (14 + 0.7) = 0.3 laps.
      // Must NOT subtract (advantage < 1.0) — protects against the edge case
      // that the original `leaderLap > lap + 1` guard was meant to handle.
      applyScenario({
        ...baseScenario,
        lap: 14,
        lapDistPct: 0.7,
        leaderLap: 15,
        leaderLapDistPct: 0.0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base: 300/105 + (15-1) + 0.0 = 2.857 + 14 = 16.857
      // Advantage = 0.3 → no subtraction → 16.857
      expect(total).toBeCloseTo(16.857, 2);
    });

    it('does NOT subtract when leader advantage is just below 1.0', () => {
      // Edge: advantage = 0.95 (leader +1 CarIdxLap, but player almost at line).
      applyScenario({
        ...baseScenario,
        lap: 14,
        lapDistPct: 0.95,
        leaderLap: 15,
        leaderLapDistPct: 0.9, // advantage = (15.9) - (14.95) = 0.95
      });
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base: 300/105 + (15-1) + 0.9 = 2.857 + 14.9 = 17.757
      // Advantage 0.95 < 1.0 → no subtraction
      expect(total).toBeCloseTo(17.757, 2);
    });

    it('subtracts exactly 1 when leader advantage is exactly 1.0', () => {
      // Boundary: advantage = 1.0 exactly.
      applyScenario({
        ...baseScenario,
        lap: 14,
        lapDistPct: 0.5,
        leaderLap: 15,
        leaderLapDistPct: 0.5, // advantage = 1.0
      });
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base: 17.357, subtract 1 → 16.357
      expect(total).toBeCloseTo(16.357, 2);
    });

    it('subtracts correctly when leader is +1 CarIdxLap but only 0.05 laps ahead', () => {
      // Leader on lap 15 at 5%, player on lap 14 at 0%.
      // Advantage = 15.05 - 14.0 = 1.05 → subtract 1.
      applyScenario({
        ...baseScenario,
        lap: 14,
        lapDistPct: 0.0,
        leaderLap: 15,
        leaderLapDistPct: 0.05,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // Base: 300/105 + (15-1) + 0.05 = 2.857 + 14.05 = 16.907
      // Advantage 1.05 → subtract 1 → 15.907
      expect(total).toBeCloseTo(15.907, 2);
    });
  });

  describe('fixed-lap race', () => {
    // The fix is in the timed-race branch; fixed-lap races use a separate
    // calculation that already accounted for lapDistPct. Verify no regression.
    const fixedScenario: Scenario = {
      lap: 14,
      lapDistPct: 0.5,
      leaderLap: 15,
      leaderLapDistPct: 0.5,
      avgLapTimeLeader: 105,
      avgLapTimePlayer: 120,
      sessionTimeRemain: 604800, // iRacing sentinel for "no time limit"
      sessionTimeTotal: 604800,
      sessionLaps: 20,
    };

    it('uses totalLaps and adjusts for leader lapping player', () => {
      applyScenario(fixedScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // totalLaps=20, leader dist=15.5, player dist=14.5, diff=1.0
      // Fixed-lap branch subtracts Math.floor(1.0) = 1 → 19
      expect(total).toBe(19);
    });

    it('does not subtract when leader is not a full lap ahead in fixed-lap race', () => {
      applyScenario({
        ...fixedScenario,
        lap: 14,
        lapDistPct: 0.7,
        leaderLap: 15,
        leaderLapDistPct: 0.0, // advantage 0.3
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(20);
    });
  });

  describe('non-race sessions', () => {
    it('returns zero totalRaceLaps when not a race', () => {
      vi.mocked(useCurrentSessionType).mockReturnValue('Practice');
      vi.mocked(useFocusCarIdx).mockReturnValue(0);
      vi.mocked(useTelemetryValue).mockReturnValue(undefined as never);
      vi.mocked(useTelemetryValues).mockReturnValue([] as never);
      vi.mocked(useTelemetryValuesRounded).mockReturnValue([] as never);
      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([]);
      vi.mocked(useSessionLapCount).mockReturnValue({
        state: 0,
        currentLap: 0,
        totalLaps: 0,
        time: 0,
        timeTotal: 0,
        timeRemaining: 0,
        greenFlagTimestamp: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(0);
    });
  });
});
