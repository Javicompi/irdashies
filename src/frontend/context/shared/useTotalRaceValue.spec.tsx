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
  useLapTimesStoreUpdater: vi.fn(),
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
  /** SessionTime (seconds since session start); used for wall-clock estimate */
  sessionTime?: number;
  /** greenFlagTimestamp (SessionTime at green flag); used for wall-clock estimate */
  greenFlagTimestamp?: number;
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
    time: s.sessionTime ?? 0,
    timeTotal: s.sessionTimeTotal,
    timeRemaining: s.sessionTimeRemain,
    greenFlagTimestamp: s.greenFlagTimestamp ?? 0,
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

  describe('user-reported 2h multi-class race (TCR + GT4, 2026-08-01)', () => {
    // Real race: 2h timed. Global leader (faster class) 62 laps with 1 pit stop
    // (~62s at lap 31); player (slower class) 54 laps with 2 pit stops +
    // drive-through. Old calculation (on-track pace, no pit time) showed 54.4
    // laps -> ceil 55 -> fuel shortage warning; actual result: 54 laps.
    // The fix projects the FUTURE at clean on-track pace (measured laps) and
    // falls back to wall-clock pace (distance since green flag) when the
    // lap-time store is cold.
    //
    // Tick simulation (leader crosses v62 at t=7200, player crosses v54 at 7259):
    //   t=7000, remain=200: leader dist 60.263, player dist 52.203 -> 53.7
    //   t=7150, remain=50:  leader dist 61.566, player dist 53.264 -> 53.6
    const raceScenario: Scenario = {
      lap: 53,
      lapDistPct: 0.203, // player on lap 53, 20.3% in -> dist 52.203
      leaderLap: 61,
      leaderLapDistPct: 0.26, // leader on lap 61, 26% in -> dist 60.26
      avgLapTimeLeader: 115.13, // leader clean on-track pace (62 laps in 7200s + 62s stop)
      avgLapTimePlayer: 134.0, // player on-track pace
      sessionTimeRemain: 200,
      sessionTimeTotal: 7200,
      sessionLaps: 32767, // iRacing sentinel for "unlimited" (timed race)
      sessionTime: 7000,
      greenFlagTimestamp: 0,
    };

    it('projects the future at clean on-track pace (pit stops not repeated)', () => {
      applyScenario(raceScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      const total = result.current.totalRaceLaps;
      // timeToCompleteCurrentLap=(1-0.26)*115.13=85.2 < remain=200
      // lapsUntilCheckered=ceil((200-85.2)/115.13)=ceil(0.997)=1
      // leaderRemainingTime=85.2+115.13=200.33
      // playerTotalLaps=52.203+200.33/134=53.70  (NOT 54.4/55 as before)
      expect(total).toBeCloseTo(53.7, 1);
    });

    it('projects leader race laps to the moment the clock reaches 0 (timed race)', () => {
      applyScenario(raceScenario);
      const { result } = renderHook(() => useTotalRaceValue());
      // leader on lap 61 @26% (dist 60.26), remain=200, pace 115.13
      // leaderRaceLaps = 60.26 + 200/115.13 = 61.997 -> 62.0 (converges to his total)
      expect(result.current.leaderRaceLaps).toBeCloseTo(62.0, 1);
    });

    it('leader race laps shows fractional value mid-race', () => {
      applyScenario({
        ...raceScenario,
        leaderLap: 61,
        leaderLapDistPct: 0.26,
        sessionTime: 6500,
        sessionTimeRemain: 700,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // leaderDist = 60.26, remain=700, pace 115.13
      // leaderRaceLaps = 60.26 + 700/115.13 = 66.34 -> 66.3
      expect(result.current.leaderRaceLaps).toBeCloseTo(66.3, 1);
    });

    it('falls back to current position when no remaining time (fixed-lap race)', () => {
      // Fixed-lap race: leaderRaceLaps stays at the leader's current position.
      applyScenario({
        lap: 14,
        lapDistPct: 0.5,
        leaderLap: 15,
        leaderLapDistPct: 0.5,
        avgLapTimeLeader: 105,
        avgLapTimePlayer: 120,
        sessionTimeRemain: 604800, // fixed-lap sentinel
        sessionTimeTotal: 604800,
        sessionLaps: 20,
        sessionTime: 300,
        greenFlagTimestamp: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // leader on lap 15 @50% -> position 14.5
      expect(result.current.leaderRaceLaps).toBeCloseTo(14.5, 1);
    });

    it('remains stable near the checkered flag (~53.6, not 55)', () => {
      applyScenario({
        ...raceScenario,
        lap: 54,
        lapDistPct: 0.264, // player dist 53.264
        leaderLap: 62,
        leaderLapDistPct: 0.56, // leader on lap 62, 56% in
        sessionTime: 7150,
        sessionTimeRemain: 50,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // timeToCompleteCurrentLap=(1-0.56)*115.13=50.66 > remain=50
      // -> checkered falls at the current lap crossing: leaderRemainingTime=50.66
      // playerTotalLaps=53.264+50.66/134=53.64
      expect(result.current.totalRaceLaps).toBeCloseTo(53.6, 1);
    });

    it('falls back to wall-clock pace when no lap-time data is available', () => {
      // avgLapTimes=[0,0] (no laps recorded yet) -> wall-clock estimate.
      applyScenario(raceScenario);
      vi.mocked(useCarIdxAverageLapTime).mockReturnValue([0, 0] as never);
      const { result } = renderHook(() => useTotalRaceValue());
      // elapsed=7000, leaderPaceWall=7000/60.26=116.16, playerPaceWall=7000/52.203=134.09
      // leaderFinalLap=ceil(7200/116.16)=62, eff=62*116.16=7201.9
      // totalRaceLaps=7201.9/134.09=53.7
      expect(result.current.totalRaceLaps).toBeCloseTo(53.7, 1);
    });

    it('falls back to pace-based estimate when green flag is unknown', () => {
      // No greenFlagTimestamp (e.g. late join before first S/F crossing):
      // wall-clock is unavailable -> legacy pace-based estimate.
      applyScenario({
        ...raceScenario,
        sessionTime: 0,
        greenFlagTimestamp: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      // Fallback: ceil(7200/115.13)=63, eff=63*115.13=7253.2, /134=54.1
      expect(result.current.totalRaceLaps).toBeCloseTo(54.1, 1);
    });
  });

  describe('user-reported 2h races where leader stops twice or is slower class', () => {
    // Race 2026-07-26 (same class as player): global leader 53 laps, 2 pit stops
    // (70s+56s=126s), on-track ~135.8s; player 53 laps, on-track ~137.3s.
    // Old calculation: ceil(7200/135.8)=54 -> 54 laps (fuel over-estimate).
    // On-track projection at t=6000: timeToCompleteCurrentLap=(1-0.25)*135.8=101.85
    //   lapsUntilCheckered=ceil((1200-101.85)/135.8)=ceil(8.086)=9
    //   leaderRemainingTime=101.85+9*135.8=1324.1
    //   playerTotalLaps=42.83+1324.1/137.3=52.47 -> 52.5
    it('2026-07-26: leader 2 stops, same class -> 52.5 laps (53 ceil)', () => {
      applyScenario({
        lap: 43,
        lapDistPct: 0.83,
        leaderLap: 44,
        leaderLapDistPct: 0.25,
        avgLapTimeLeader: 135.8,
        avgLapTimePlayer: 137.3,
        sessionTimeRemain: 1200,
        sessionTimeTotal: 7200,
        sessionLaps: 32767,
        sessionTime: 6000,
        greenFlagTimestamp: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBeCloseTo(52.5, 1);
    });

    // Race 2026-07-25 (player in FASTER class, leader is slower-class TCR):
    // global leader 53 laps, 1 pit stop (60s), on-track ~137.1s; player 53 laps,
    // on-track ~137.5s. Old calculation over-estimated -> fuel over-estimate.
    // On-track projection at t=6000: timeToCompleteCurrentLap=(1-0.33)*137.1=91.9
    //   lapsUntilCheckered=ceil((1200-91.9)/137.1)=ceil(8.081)=9
    //   leaderRemainingTime=91.9+9*137.1=1325.8
    //   playerTotalLaps=42.84+1325.8/137.5=52.48 -> 52.5
    it('2026-07-25: slower-class leader, 1 stop -> 52.5 laps (53 ceil)', () => {
      applyScenario({
        lap: 43,
        lapDistPct: 0.84,
        leaderLap: 44,
        leaderLapDistPct: 0.33,
        avgLapTimeLeader: 137.1,
        avgLapTimePlayer: 137.5,
        sessionTimeRemain: 1200,
        sessionTimeTotal: 7200,
        sessionLaps: 32767,
        sessionTime: 6000,
        greenFlagTimestamp: 0,
      });
      const { result } = renderHook(() => useTotalRaceValue());
      expect(result.current.totalRaceLaps).toBeCloseTo(52.5, 1);
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
