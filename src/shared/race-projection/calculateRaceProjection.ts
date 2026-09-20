import { SessionState } from '@irdashies/types';

/**
 * Canonical race-lap projection shared by the main-process
 * `SessionTimingProcessor` and (via the `session-timing.snapshot` channel)
 * every renderer consumer.
 *
 * This is a faithful port of the renderer-side `useTotalRaceValue` timed-race
 * logic: timed races estimate the player's total laps from the moment the
 * overall leader (CarIdxPosition === 1, i.e. the fastest class in a
 * multi-class race) will take the checkered flag, using each car's own clean
 * on-track pace.
 *
 * Rules (ARCHITECTURE_RULES R5.2): pure and deterministic — no React, no I/O,
 * no clock reads. The caller owns `lastLeaderRaceLaps` persistence (in the
 * processor) and passes it back in.
 */
export interface RaceProjectionInput {
  sessionType?: string;
  state: number;
  /** Fixed-lap race = SessionLaps is a number > 0. Timed races report 0. */
  isFixedLapRace: boolean;
  /** Configured lap count (SessionLaps). 0 for timed races. */
  totalLaps: number;
  timeRemaining?: number;
  timeTotal: number;
  /** SessionTime - greenFlagTimestamp. <= 0 means the green is unobserved. */
  elapsed: number;
  /** Player (focus car) current lap, 1-indexed. */
  playerLap: number;
  playerLapDistPct: number;
  /** Overall leader current lap, 1-indexed. -1 when not reporting. */
  leaderLap: number;
  leaderLapDistPct: number;
  /** Clean on-track pace (avg lap times, pit-stop laps filtered out). */
  leaderPace: number;
  playerPace: number;
  /** Wall-clock pace (elapsed / distance, pit losses spread over every lap). */
  leaderPaceWall: number;
  playerPaceWall: number;
  /** Pace fallback for the last-resort estimate (avg || classEst || best). */
  leaderAvgLapTime: number;
  playerAvgLapTime: number;
  /** Last valid leader projection (retained across the checkered flag). */
  lastLeaderRaceLaps: number;
}

export interface RaceProjectionResult {
  totalRaceLaps: number;
  leaderRaceLaps: number;
  totalRaceTime: number;
  adjustedRaceTime: number;
}

export const round1dp = (value: number): number => Math.round(value * 10) / 10;

/**
 * Canonical "laps remaining" derived from a projected total. Counts the
 * fraction of the current lap already completed, so the SessionBar
 * `Remaining` mode (`ceil` of this) and the fuel calculator agree.
 */
export const calculateLapsRemaining = (
  totalRaceLaps: number,
  playerLap: number,
  playerLapDistPct: number
): number => {
  if (!(totalRaceLaps > 0)) return 0;
  const total = Math.ceil(totalRaceLaps);
  const completed =
    (playerLap > 0 ? playerLap - 1 : 0) + (playerLapDistPct ?? 0);
  return Math.max(0, total - completed);
};

export function calculateRaceProjection(
  input: RaceProjectionInput
): RaceProjectionResult {
  const result: RaceProjectionResult = {
    totalRaceLaps: 0,
    leaderRaceLaps: 0,
    totalRaceTime: 0,
    adjustedRaceTime: 0,
  };

  // No race, no business
  if (input.sessionType !== 'Race') return result;

  // Leader's race lap count (current position; projected in the timed branch).
  // When the leader stops reporting telemetry (post-checkered, CarIdxLap=-1),
  // fall back to the last valid projection.
  if (input.leaderLap > 0) {
    result.leaderRaceLaps = round1dp(
      input.leaderLap - 1 + input.leaderLapDistPct
    );
  } else if (input.lastLeaderRaceLaps > 0) {
    result.leaderRaceLaps = input.lastLeaderRaceLaps;
  }

  if (input.isFixedLapRace) {
    // Easy case, fixed lap count. We just have to account for the race
    // leader that might have lapped us.
    result.totalRaceLaps = input.totalLaps;

    if (input.playerLap > 0 && input.leaderLap > 0) {
      const totalDist = input.playerLap + input.playerLapDistPct;
      const totalLeaderDist = input.leaderLap + input.leaderLapDistPct;

      if (totalLeaderDist > totalDist) {
        result.totalRaceLaps -= Math.floor(totalLeaderDist - totalDist);
      }
    }

    // Race clock: based on the leader's pace (race ends when he finishes).
    if (input.leaderAvgLapTime > 0) {
      result.totalRaceTime = input.totalLaps * input.leaderAvgLapTime;
      result.adjustedRaceTime = result.totalRaceLaps * input.leaderAvgLapTime;
    }
  } else {
    // Time-limited race: estimate based on when the leader will receive the
    // checkered flag. Past progress (distance since green flag) is measured;
    // the FUTURE is projected at each car's clean on-track pace (pit-stop
    // laps filtered out). Using the wall-clock average (elapsed / distance,
    // which spreads past pit losses over every lap) under-estimates remaining
    // laps once the leader's stops are done, since those stops will not
    // repeat. The wall-clock pace is kept as a fallback when the lap-time
    // store has no data yet (e.g. cold store / very early race).
    result.totalRaceTime = input.timeTotal;

    const leaderDist =
      input.leaderLap > 0 ? input.leaderLap - 1 + input.leaderLapDistPct : 0;
    const playerDist =
      input.playerLap > 0 ? input.playerLap - 1 + input.playerLapDistPct : 0;

    // Project the leader's lap count at the moment the race clock reaches
    // 0 (timeRemaining): current position + laps covered in the remaining
    // time at his clean on-track pace.
    if (
      input.timeRemaining !== undefined &&
      input.timeRemaining >= 0 &&
      leaderDist > 0 &&
      input.leaderPace > 1
    ) {
      result.leaderRaceLaps = round1dp(
        leaderDist + input.timeRemaining / input.leaderPace
      );
    }

    if (
      input.elapsed > 0 &&
      input.timeRemaining !== undefined &&
      input.timeRemaining >= 0 &&
      leaderDist > 0 &&
      playerDist > 0 &&
      input.leaderPace > 1 &&
      input.playerPace > 1
    ) {
      // Project the leader's remaining laps at his clean on-track pace:
      // past pit stops will not repeat. The checkered flag falls when the
      // leader crosses the line after the time limit, so he always completes
      // the current lap and every lap whose crossing happens after the limit.
      const timeToCompleteCurrentLap =
        (1 - input.leaderLapDistPct) * input.leaderPace;
      let leaderRemainingTime: number;
      if (input.timeRemaining <= timeToCompleteCurrentLap) {
        // The crossing of the current lap happens at/after the limit:
        // the checkered flag falls there.
        leaderRemainingTime = timeToCompleteCurrentLap;
      } else {
        // The leader completes the current lap before the limit, then
        // keeps completing laps until (and including) the first
        // crossing that happens after the limit.
        const lapsUntilCheckered = Math.ceil(
          (input.timeRemaining - timeToCompleteCurrentLap) / input.leaderPace
        );
        leaderRemainingTime =
          timeToCompleteCurrentLap + lapsUntilCheckered * input.leaderPace;
      }
      const playerTotalLaps =
        playerDist + leaderRemainingTime / input.playerPace;
      result.totalRaceLaps = round1dp(playerTotalLaps);
    } else if (
      input.timeRemaining !== undefined &&
      input.timeRemaining >= 0 &&
      input.leaderPaceWall > 1 &&
      input.playerPaceWall > 1
    ) {
      // Fallback (lap-time store not populated yet): wall-clock pace estimate.
      const leaderFinalLap = Math.ceil(
        (input.elapsed + input.timeRemaining) / input.leaderPaceWall
      );
      const effectiveRaceTime = leaderFinalLap * input.leaderPaceWall;
      result.totalRaceLaps = round1dp(effectiveRaceTime / input.playerPaceWall);
    } else if (
      input.timeTotal > 0 &&
      input.leaderAvgLapTime > 1 &&
      input.playerAvgLapTime > 1
    ) {
      // Last-resort fallback (e.g. green flag not observed yet).
      const leaderEstimatedLaps = Math.ceil(
        input.timeTotal / input.leaderAvgLapTime
      );
      const effectiveRaceTime = leaderEstimatedLaps * input.leaderAvgLapTime;
      result.totalRaceLaps = round1dp(
        effectiveRaceTime / input.playerAvgLapTime
      );
    }

    if (input.totalLaps > 0 && result.totalRaceLaps > input.totalLaps) {
      result.totalRaceLaps = input.totalLaps;
    }
  }

  if (input.state >= SessionState.Checkered) {
    // After checkered: freeze at the lap count captured when the flag was
    // shown; keep showing the last valid leader projection.
    return {
      totalRaceLaps: input.playerLap,
      totalRaceTime: result.totalRaceTime,
      adjustedRaceTime: result.adjustedRaceTime,
      leaderRaceLaps:
        result.leaderRaceLaps > 0
          ? result.leaderRaceLaps
          : input.lastLeaderRaceLaps,
    };
  }

  return result;
}
