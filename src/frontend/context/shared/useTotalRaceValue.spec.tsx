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

  describe('timed race (time-limited, leader checkered-flag estimate)', () => {
    // Timed races estimate the player's total laps based on when the global
    // leader will receive the checkered flag, using the player's own pace.
    // Formula: ceil(timeTotal / leaderPace) * leaderPace / playerPace
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

    it('estimates total laps from leader and player average pace', () => {
      // leader: ceil(1800/105)=18, raceDuration=18*105=1890
      // player: 1890/120=15.75 → Math.round(157.5)/10=15.8
      applyScenario(baseScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(15.8);
    });

    it('same class with identical paces returns exact division', () => {
      // timeTotal=1800, leader=120, player=120: ceil(1800/120)=15, 15*120/120=15.0
      applyScenario({
        ...baseScenario,
        avgLapTimeLeader: 120,
        avgLapTimePlayer: 120,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(15.0);
    });

    it('rounds up leader laps with ceil, extending race beyond timeTotal', () => {
      // timeTotal=1700, leader 105: 1700/105=16.19, ceil=17, eff=17*105=1785
      // player 120: 1785/120=14.875 → Math.round(148.75)/10=14.9
      applyScenario({
        ...baseScenario,
        sessionTimeTotal: 1700,
        sessionTimeRemain: 200,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBeCloseTo(14.9, 1);
    });

    it('produces stable estimate independent of current lap progress', () => {
      // Changing lap/progress should not affect the forward-looking estimate
      applyScenario({
        ...baseScenario,
        lap: 8,
        lapDistPct: 0.2,
        leaderLap: 8,
        leaderLapDistPct: 0.8,
        sessionTimeRemain: 1500,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(15.8);
    });

    it('rounds to 1 decimal place', () => {
      // leader 90, player 97: ceil(1800/90)=20, eff=1800, 1800/97=18.5567 → 18.6
      applyScenario({
        ...baseScenario,
        avgLapTimeLeader: 90,
        avgLapTimePlayer: 97,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(18.6);
    });

    it('falls back to class estimated lap time when no avg lap time', () => {
      applyScenario(baseScenario);

      const classEstLapTimes: Record<number, number> = {};
      classEstLapTimes[PLAYER_CAR_IDX] = 125;

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue(
        classEstLapTimes as never,
      );
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([
        0,
        baseScenario.avgLapTimeLeader,
      ]);

      const { result } = renderHook(() => useTotalRaceValue());
      // leader: ceil(1800/105)=18, eff=1890, player fallback: 1890/125=15.12 → 15.1
      expect(result.current.totalRaceLaps).toBe(15.1);
    });

    it('falls back to best lap time when no avg and no class est', () => {
      applyScenario(baseScenario);

      const playerBestLapTime = 118;

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([
        0,
        baseScenario.avgLapTimeLeader,
      ]);
      vi.mocked(useTelemetryValues).mockImplementation((key: string) => {
        if (key === 'CarIdxLap')
          return [baseScenario.lap, baseScenario.leaderLap];
        if (key === 'CarIdxPosition') return [2, 1];
        if (key === 'CarIdxBestLapTime')
          return [playerBestLapTime, -1];
        return undefined as never;
      });

      const { result } = renderHook(() => useTotalRaceValue());
      // leader: ceil(1800/105)=18, eff=1890, player best: 1890/118=16.0169 → 16.0
      expect(result.current.totalRaceLaps).toBe(16.0);
    });

    it('returns 0 when leader lap time is invalid (replay)', () => {
      applyScenario({
        ...baseScenario,
        avgLapTimeLeader: 1,
        avgLapTimePlayer: 120,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(0);
    });

    it('returns 0 when player lap time is invalid', () => {
      applyScenario({
        ...baseScenario,
        avgLapTimeLeader: 105,
        avgLapTimePlayer: 1,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(0);
    });

    it('returns 0 when no lap time data available', () => {
      applyScenario(baseScenario);

      vi.mocked(useCarIdxClassEstLapTime).mockReturnValue({} as never);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([0, 0]);
      vi.mocked(useTelemetryValues).mockImplementation((key: string) => {
        if (key === 'CarIdxLap')
          return [baseScenario.lap, baseScenario.leaderLap];
        if (key === 'CarIdxPosition') return [2, 1];
        if (key === 'CarIdxBestLapTime') return [-1, -1];
        return undefined as never;
      });

      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBe(0);
    });
  });

  describe('fixed-lap race', () => {
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

    it('does not subtract when leader is not a full lap ahead', () => {
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
