import { describe, expect, it } from 'vitest';
import { SessionState } from '@irdashies/types';
import {
  calculateLapsRemaining,
  calculateRaceProjection,
  type RaceProjectionInput,
} from './calculateRaceProjection';

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
  sessionTime?: number;
  greenFlagTimestamp?: number;
  classEstPlayer?: number;
  bestPlayer?: number;
}

/** Mirror the input wiring of the former renderer hook / processor. */
function toInput(s: Scenario): RaceProjectionInput {
  const sessionTime = s.sessionTime ?? 0;
  const greenFlagTimestamp = s.greenFlagTimestamp ?? 0;
  const elapsed = sessionTime - greenFlagTimestamp;
  const leaderDist = s.leaderLap > 0 ? s.leaderLap - 1 + s.leaderLapDistPct : 0;
  const playerDist = s.lap > 0 ? s.lap - 1 + s.lapDistPct : 0;
  const leaderPace = s.avgLapTimeLeader ?? 0;
  const playerPace = s.avgLapTimePlayer ?? 0;
  return {
    sessionType: 'Race',
    state: SessionState.Racing,
    isFixedLapRace: s.sessionLaps > 0,
    totalLaps: s.sessionLaps,
    timeRemaining: s.sessionTimeRemain,
    timeTotal: s.sessionTimeTotal,
    elapsed,
    playerLap: s.lap,
    playerLapDistPct: s.lapDistPct,
    leaderLap: s.leaderLap,
    leaderLapDistPct: s.leaderLapDistPct,
    leaderPace,
    playerPace,
    leaderPaceWall: elapsed > 0 && leaderDist > 0 ? elapsed / leaderDist : 0,
    playerPaceWall: elapsed > 0 && playerDist > 0 ? elapsed / playerDist : 0,
    leaderAvgLapTime:
      leaderPace > 0
        ? leaderPace
        : (s.classEstPlayer ?? 0) > 0
          ? (s.classEstPlayer ?? 0)
          : (s.bestPlayer ?? 0),
    playerAvgLapTime:
      playerPace > 0
        ? playerPace
        : (s.classEstPlayer ?? 0) > 0
          ? (s.classEstPlayer ?? 0)
          : (s.bestPlayer ?? 0),
    lastLeaderRaceLaps: 0,
  };
}

describe('calculateRaceProjection', () => {
  describe('timed multi-class race (faster-class leader)', () => {
    // Leader LMP3 105s, player GT4 120s. Green unobserved (elapsed 0), so the
    // last-resort pace estimate applies:
    // leader: ceil(1800/105)=18, eff=1890, player: 1890/120=15.75 -> 15.8
    const base: Scenario = {
      lap: 14,
      lapDistPct: 0.5,
      leaderLap: 15,
      leaderLapDistPct: 0.5,
      avgLapTimeLeader: 105,
      avgLapTimePlayer: 120,
      sessionTimeRemain: 300,
      sessionTimeTotal: 1800,
      sessionLaps: 0,
    };

    it('estimates total laps from leader and player average pace', () => {
      expect(calculateRaceProjection(toInput(base)).totalRaceLaps).toBe(15.8);
    });

    it('same class with identical paces returns exact division', () => {
      const result = calculateRaceProjection(
        toInput({ ...base, avgLapTimeLeader: 120, avgLapTimePlayer: 120 })
      );
      expect(result.totalRaceLaps).toBe(15.0);
    });

    it('rounds up leader laps with ceil, extending race beyond timeTotal', () => {
      // timeTotal=1700, leader 105: ceil=17, eff=1785, 1785/120=14.875 -> 14.9
      const result = calculateRaceProjection(
        toInput({ ...base, sessionTimeTotal: 1700, sessionTimeRemain: 200 })
      );
      expect(result.totalRaceLaps).toBeCloseTo(14.9, 1);
    });

    it('falls back to class estimated lap time when no avg lap time', () => {
      // player avg 0 -> classEst 125: 1890/125=15.12 -> 15.1
      const result = calculateRaceProjection(
        toInput({ ...base, avgLapTimePlayer: 0, classEstPlayer: 125 })
      );
      expect(result.totalRaceLaps).toBe(15.1);
    });

    it('returns 0 when leader pace is invalid', () => {
      const result = calculateRaceProjection(
        toInput({ ...base, avgLapTimeLeader: 1 })
      );
      expect(result.totalRaceLaps).toBe(0);
    });
  });

  describe('user-reported 2h multi-class race (TCR + GT4)', () => {
    // Global leader (faster class) 62 laps, player (slower class) 54 laps.
    const race: Scenario = {
      lap: 53,
      lapDistPct: 0.203,
      leaderLap: 61,
      leaderLapDistPct: 0.26,
      avgLapTimeLeader: 115.13,
      avgLapTimePlayer: 134.0,
      sessionTimeRemain: 200,
      sessionTimeTotal: 7200,
      sessionLaps: 0,
      sessionTime: 7000,
      greenFlagTimestamp: 0,
    };

    it('projects the future at clean on-track pace (pit stops not repeated)', () => {
      // timeToCompleteCurrentLap=(1-0.26)*115.13=85.2 < remain=200
      // lapsUntilCheckered=ceil((200-85.2)/115.13)=1
      // leaderRemainingTime=85.2+115.13=200.33
      // playerTotalLaps=52.203+200.33/134=53.70 (NOT 54.4/55 as before)
      expect(calculateRaceProjection(toInput(race)).totalRaceLaps).toBeCloseTo(
        53.7,
        1
      );
    });

    it('projects leader race laps to the moment the clock reaches 0', () => {
      // 60.26 + 200/115.13 = 61.997 -> 62.0 (converges to his total)
      expect(calculateRaceProjection(toInput(race)).leaderRaceLaps).toBeCloseTo(
        62.0,
        1
      );
    });

    it('leader race laps shows fractional value mid-race', () => {
      const result = calculateRaceProjection(
        toInput({
          ...race,
          sessionTime: 6500,
          sessionTimeRemain: 700,
        })
      );
      // 60.26 + 700/115.13 = 66.34 -> 66.3
      expect(result.leaderRaceLaps).toBeCloseTo(66.3, 1);
    });

    it('remains stable near the checkered flag (~53.6, not 55)', () => {
      const result = calculateRaceProjection(
        toInput({
          ...race,
          lap: 54,
          lapDistPct: 0.264,
          leaderLap: 62,
          leaderLapDistPct: 0.56,
          sessionTime: 7150,
          sessionTimeRemain: 50,
        })
      );
      // timeToCompleteCurrentLap=(1-0.56)*115.13=50.66 > remain=50
      // -> leaderRemainingTime=50.66, playerTotalLaps=53.264+50.66/134=53.64
      expect(result.totalRaceLaps).toBeCloseTo(53.6, 1);
    });

    it('falls back to wall-clock pace when no lap-time data is available', () => {
      const result = calculateRaceProjection(
        toInput({ ...race, avgLapTimeLeader: 0, avgLapTimePlayer: 0 })
      );
      // elapsed=7000, leaderPaceWall=7000/60.26=116.16,
      // playerPaceWall=7000/52.203=134.09
      // leaderFinalLap=ceil(7200/116.16)=62, eff=7201.9, /134.09=53.7
      expect(result.totalRaceLaps).toBeCloseTo(53.7, 1);
    });

    it('falls back to pace-based estimate when green flag is unknown', () => {
      const result = calculateRaceProjection(
        toInput({ ...race, sessionTime: 0, greenFlagTimestamp: 0 })
      );
      // ceil(7200/115.13)=63, eff=7253.2, /134=54.1
      expect(result.totalRaceLaps).toBeCloseTo(54.1, 1);
    });

    it('REGRESSION: clock at 0 must NOT collapse to fixed-lap / 0', () => {
      const result = calculateRaceProjection(
        toInput({ ...race, sessionTime: 7457, sessionTimeRemain: 0 })
      );
      expect(result.totalRaceLaps).toBeCloseTo(52.8, 1);
      expect(result.leaderRaceLaps).toBeCloseTo(60.3, 1);
    });

    it('slower-class leader with faster-class player still converges', () => {
      // Player in the FASTER class, overall leader slower (TCR):
      // leaderRemainingTime=91.9+9*137.1=1325.8,
      // playerTotalLaps=42.84+1325.8/137.5=52.48 -> 52.5
      const result = calculateRaceProjection(
        toInput({
          lap: 43,
          lapDistPct: 0.84,
          leaderLap: 44,
          leaderLapDistPct: 0.33,
          avgLapTimeLeader: 137.1,
          avgLapTimePlayer: 137.5,
          sessionTimeRemain: 1200,
          sessionTimeTotal: 7200,
          sessionLaps: 0,
          sessionTime: 6000,
          greenFlagTimestamp: 0,
        })
      );
      expect(result.totalRaceLaps).toBeCloseTo(52.5, 1);
    });
  });

  describe('fixed-lap races', () => {
    it('uses the configured lap count minus laps down to the leader', () => {
      const result = calculateRaceProjection(
        toInput({
          lap: 14,
          lapDistPct: 0.5,
          leaderLap: 15,
          leaderLapDistPct: 0.5,
          avgLapTimeLeader: 105,
          avgLapTimePlayer: 120,
          sessionTimeRemain: 604800,
          sessionTimeTotal: 604800,
          sessionLaps: 20,
          sessionTime: 300,
          greenFlagTimestamp: 0,
        })
      );
      // totalLaps=20, leader dist=15.5, player dist=14.5, diff=1.0
      // Fixed-lap branch subtracts Math.floor(1.0) = 1 -> 19
      expect(result.totalRaceLaps).toBe(19);
      // leaderRaceLaps stays at the leader's current position (14.5)
      expect(result.leaderRaceLaps).toBeCloseTo(14.5, 1);
    });

    it('does not subtract when the leader is not a full lap ahead', () => {
      const result = calculateRaceProjection(
        toInput({
          lap: 14,
          lapDistPct: 0.7,
          leaderLap: 15,
          leaderLapDistPct: 0.0, // advantage 0.3
          avgLapTimeLeader: 105,
          avgLapTimePlayer: 120,
          sessionTimeRemain: 604800,
          sessionTimeTotal: 604800,
          sessionLaps: 20,
          sessionTime: 300,
          greenFlagTimestamp: 0,
        })
      );
      expect(result.totalRaceLaps).toBe(20);
    });
  });

  describe('session boundaries', () => {
    const timedInput = (overrides: Partial<RaceProjectionInput>) =>
      ({
        sessionType: 'Race',
        state: SessionState.Racing,
        isFixedLapRace: false,
        totalLaps: 0,
        timeRemaining: 200,
        timeTotal: 7200,
        elapsed: 7000,
        playerLap: 53,
        playerLapDistPct: 0.203,
        leaderLap: 61,
        leaderLapDistPct: 0.26,
        leaderPace: 115.13,
        playerPace: 134.0,
        leaderPaceWall: 116.16,
        playerPaceWall: 134.09,
        leaderAvgLapTime: 115.13,
        playerAvgLapTime: 134.0,
        lastLeaderRaceLaps: 0,
        ...overrides,
      }) satisfies RaceProjectionInput;

    it('returns zeros when not a race', () => {
      expect(
        calculateRaceProjection(timedInput({ sessionType: 'Practice' }))
      ).toEqual({
        totalRaceLaps: 0,
        leaderRaceLaps: 0,
        totalRaceTime: 0,
        adjustedRaceTime: 0,
      });
    });

    it('keeps the last valid leaderRaceLaps when the leader stops reporting', () => {
      const racing = calculateRaceProjection(timedInput({}));
      expect(racing.leaderRaceLaps).toBeGreaterThan(60);
      const checkered = calculateRaceProjection(
        timedInput({
          state: SessionState.Checkered,
          leaderLap: -1,
          leaderLapDistPct: -1,
          lastLeaderRaceLaps: racing.leaderRaceLaps,
        })
      );
      // totalRaceLaps freezes at the player's lap; leader keeps last valid.
      expect(checkered.totalRaceLaps).toBe(53);
      expect(checkered.leaderRaceLaps).toBeGreaterThan(60);
    });

    it('freezes totalRaceLaps at the player lap after checkered', () => {
      const result = calculateRaceProjection(
        timedInput({ state: SessionState.Checkered })
      );
      expect(result.totalRaceLaps).toBe(53);
    });
  });
});

describe('calculateLapsRemaining', () => {
  it('counts the completed fraction of the current lap', () => {
    // total 53.7 -> ceil 54, completed (53-1)+0.203=52.203 -> 1.797
    expect(calculateLapsRemaining(53.7, 53, 0.203)).toBeCloseTo(1.8, 1);
  });

  it('ceil matches the SessionBar Remaining countdown', () => {
    expect(Math.ceil(calculateLapsRemaining(53.7, 53, 0.203))).toBe(2);
    expect(Math.ceil(calculateLapsRemaining(53.7, 53, 0))).toBe(2);
  });

  it('returns 0 without a projection', () => {
    expect(calculateLapsRemaining(0, 53, 0.2)).toBe(0);
  });
});
