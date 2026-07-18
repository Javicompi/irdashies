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
  // CarIdxBestLapTime: player's best and leader's best
  const carIdxBestLapTime = [s.avgLapTimePlayer, s.avgLapTimeLeader];

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

  describe('timed race (time-limited, player pace)', () => {
    // Timed races estimate the player's total laps using the PLAYER's pace,
    // not the leader's. This is critical in multi-class where the leader is
    // faster and would overestimate the player's lap count.
    const baseScenario: Scenario = {
      lap: 14,
      lapDistPct: 0.5,
      leaderLap: 15,
      leaderLapDistPct: 0.5,
      avgLapTimeLeader: 105, // LMP3 (faster class)
      avgLapTimePlayer: 120, // GT4 (player, slower class)
      sessionTimeRemain: 300,
      sessionTimeTotal: 1800,
      sessionLaps: 32767, // iRacing sentinel for "unlimited" (timed race)
    };

    it('multi-class: uses player pace, not leader pace', () => {
      // Player on lap 14 at 50%, 300s remaining, player pace 120s.
      // totalRaceLaps = 300/120 + (14-1) + 0.5 = 2.5 + 13.5 = 16.0
      // If leader pace (105) were used: 300/105 + (15-1) + 0.5 = 17.357 (wrong)
      applyScenario(baseScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBeCloseTo(16.0, 2);
    });

    it('multi-class: does NOT subtract leader advantage (player pace already correct)', () => {
      // Leader is +5 laps ahead. With player pace, this is irrelevant —
      // the player will complete laps based on their own speed.
      applyScenario({
        ...baseScenario,
        leaderLap: 19,
        leaderLapDistPct: 0.5, // leader +5 laps
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // Same as base: 300/120 + 13 + 0.5 = 16.0
      expect(result.current.totalRaceLaps).toBeCloseTo(16.0, 2);
    });

    it('single-class: player pace equals leader pace, same result', () => {
      applyScenario({
        ...baseScenario,
        avgLapTimeLeader: 120, // same as player
        leaderLap: 14, // same lap as player
        leaderLapDistPct: 0.5,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // 300/120 + 13 + 0.5 = 16.0
      expect(result.current.totalRaceLaps).toBeCloseTo(16.0, 2);
    });

    it('includes current lap progress via lapDistPct', () => {
      applyScenario({
        ...baseScenario,
        lap: 14,
        lapDistPct: 0.9, // 90% of current lap completed
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // 300/120 + 13 + 0.9 = 16.4
      expect(result.current.totalRaceLaps).toBeCloseTo(16.4, 2);
    });

    it('handles lap 0 (race not yet started) with player pace', () => {
      applyScenario({
        ...baseScenario,
        lap: 0,
        lapDistPct: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // timeTotal / playerPace = 1800/120 = 15.0
      expect(result.current.totalRaceLaps).toBeCloseTo(15.0, 2);
    });

    it('falls back to class estimated lap time when no avg lap time', () => {
      applyScenario(baseScenario); // set up base mocks first

      const classEstLapTimes: Record<number, number> = {};
      classEstLapTimes[PLAYER_CAR_IDX] = 125; // class est for player

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue(classEstLapTimes as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([
        0, // no avg lap time for player
        baseScenario.avgLapTimeLeader,
      ]);

      const { result } = renderHook(() => useTotalRaceValue());
      // 300/125 + 13 + 0.5 = 2.4 + 13.5 = 15.9
      expect(result.current.totalRaceLaps).toBeCloseTo(15.9, 2);
    });

    it('falls back to best lap time when no avg and no class est', () => {
      applyScenario(baseScenario); // set up base mocks first

      const playerBestLapTime = 118;

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([
        0, // no avg lap time for player
        baseScenario.avgLapTimeLeader,
      ]);
      // Override CarIdxBestLapTime to provide player's best
      vi.mocked(useTelemetryValues).mockImplementation((key: string) => {
        if (key === 'CarIdxLap') return [baseScenario.lap, baseScenario.leaderLap];
        if (key === 'CarIdxPosition') return [2, 1];
        if (key === 'CarIdxBestLapTime') return [playerBestLapTime, -1];
        return undefined as never;
      });

      const { result } = renderHook(() => useTotalRaceValue());
      // 300/118 + 13 + 0.5 = 2.542 + 13.5 = 16.042
      expect(result.current.totalRaceLaps).toBeCloseTo(16.04, 1);
    });

    it('returns 0 when no lap time data available', () => {
      applyScenario(baseScenario); // set up base mocks first

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([0, 0]);
      vi.mocked(useTelemetryValues).mockImplementation((key: string) => {
        if (key === 'CarIdxLap') return [baseScenario.lap, baseScenario.leaderLap];
        if (key === 'CarIdxPosition') return [2, 1];
        if (key === 'CarIdxBestLapTime') return [-1, -1];
        return undefined as never;
      });

      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(0);
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
