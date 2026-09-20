import type {
  Session,
  SessionLifecycleEvent,
  SessionTimingSnapshot,
  Telemetry,
} from '@irdashies/types';
import { SessionState } from '@irdashies/types';
import {
  calculateRaceProjection,
  type RaceProjectionInput,
} from '@irdashies/shared';
import type { TelemetryProcessor } from './TelemetryProcessor';

const UPDATE_INTERVAL_SECONDS = 0.2;
const TIME_EPSILON = 1e-6;

const numberValue = (frame: Telemetry, key: keyof Telemetry): number | null => {
  const value = frame[key]?.value?.[0];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const numberArray = (frame: Telemetry, key: keyof Telemetry): unknown[] => {
  const value = frame[key]?.value;
  return Array.isArray(value) ? value : [];
};

const finiteAt = (values: unknown[], index: number | null): number => {
  if (index === null || index < 0) return 0;
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export class SessionTimingProcessor implements TelemetryProcessor<SessionTimingSnapshot> {
  readonly channel = 'session-timing.snapshot';
  readonly tickRateHz = 5;

  private session?: Session;
  private driverCarIdx: number | null = null;
  private lastUpdateTime: number | null = null;
  private previousSessionState: number | null = null;
  private previousLeaderLap: number | null = null;
  private greenFlagTimestamp: number | null = null;
  private lastLeaderRaceLaps = 0;
  private checkeredLap: number | null = null;
  private lateJoin = false;
  private enabled = true;
  private latest = this.emptySnapshot();

  constructor(private readonly lapTimes: () => readonly number[] = () => []) {}

  init(session: Session): void {
    this.session = session;
    const carIdx = session.DriverInfo?.DriverCarIdx;
    this.driverCarIdx =
      typeof carIdx === 'number' && carIdx >= 0 ? carIdx : null;
  }

  onFrame(frame: Telemetry): void {
    if (!this.enabled) return;
    const sessionTime = numberValue(frame, 'SessionTime');
    if (sessionTime === null) return;
    const sessionNum = numberValue(frame, 'SessionNum');
    const focusCarIdx = this.focusCarIdx(frame);
    const timeWentBackwards =
      this.lastUpdateTime !== null && sessionTime < this.lastUpdateTime;
    const sessionChanged =
      this.latest.sessionNum !== null && sessionNum !== this.latest.sessionNum;
    if (timeWentBackwards || sessionChanged) this.reset(sessionNum);
    if (
      this.lastUpdateTime !== null &&
      sessionTime - this.lastUpdateTime < UPDATE_INTERVAL_SECONDS - TIME_EPSILON
    ) {
      return;
    }
    this.lastUpdateTime = sessionTime;

    const state = numberValue(frame, 'SessionState') ?? 0;
    const sessionInfo = this.session?.SessionInfo?.Sessions?.find(
      (entry) => entry.SessionNum === sessionNum
    );
    const sessionType = sessionInfo?.SessionType;
    const laps = numberArray(frame, 'CarIdxLap');
    const positions = numberArray(frame, 'CarIdxPosition');
    const lapDistPcts = numberArray(frame, 'CarIdxLapDistPct');
    const currentLap = finiteAt(laps, focusCarIdx);
    let leaderCarIdx = -1;
    for (let index = 0; index < positions.length; index += 1) {
      if (positions[index] === 1) {
        leaderCarIdx = index;
        break;
      }
    }
    const leaderLap = finiteAt(laps, leaderCarIdx);
    const leaderLapDistPct = finiteAt(lapDistPcts, leaderCarIdx);

    this.updateGreenFlag(
      sessionType,
      state,
      sessionTime,
      leaderCarIdx,
      leaderLap
    );
    if (state >= SessionState.Checkered) {
      if (this.checkeredLap === null && currentLap > 0) {
        this.checkeredLap = currentLap;
      }
    } else {
      this.checkeredLap = null;
    }

    const timeTotal = numberValue(frame, 'SessionTimeTotal') ?? 0;
    const rawTimeRemaining = numberValue(frame, 'SessionTimeRemain') ?? 0;
    const timeRemaining =
      sessionType === 'Race' &&
      state === SessionState.GetInCar &&
      rawTimeRemaining >= 604800 &&
      timeTotal >= 604800
        ? -1
        : rawTimeRemaining;
    const totalLaps =
      typeof sessionInfo?.SessionLaps === 'number'
        ? sessionInfo.SessionLaps
        : 0;
    // Fixed-lap race = SessionLaps is a number > 0. Timed races report
    // "unlimited" -> 0. Deliberately NOT derived from timeRemaining: when the
    // clock hits 0 at the end of a timed race, timeRemaining becomes 0 and a
    // timeRemaining-based check wrongly flips to "fixed-lap".
    const fixedLapRace = totalLaps > 0;
    const displayLap =
      state >= SessionState.Checkered
        ? (this.checkeredLap ?? currentLap)
        : currentLap;
    const raceValues = this.calculateRaceValues(
      frame,
      sessionType,
      state,
      sessionTime,
      focusCarIdx,
      displayLap,
      leaderCarIdx,
      leaderLap,
      leaderLapDistPct,
      totalLaps,
      timeRemaining,
      timeTotal,
      fixedLapRace
    );
    if (raceValues.leaderRaceLaps > 0) {
      this.lastLeaderRaceLaps = raceValues.leaderRaceLaps;
    }

    this.latest = {
      sessionType,
      state,
      currentLap: displayLap,
      totalLaps,
      time: sessionTime,
      timeTotal,
      timeRemaining,
      greenFlagTimestamp: this.greenFlagTimestamp ?? 0,
      isFixedLapRace: fixedLapRace,
      ...raceValues,
      sessionNum,
      version: this.latest.version + 1,
    };
    this.previousSessionState = state;
    this.previousLeaderLap = leaderLap;
  }

  onLifecycle(event: SessionLifecycleEvent): void {
    if (event.type === 'enter') {
      this.enabled = !event.replay;
      if (event.replay) this.reset(null);
      return;
    }
    this.reset(null);
  }

  snapshot(): SessionTimingSnapshot {
    return this.latest;
  }

  private focusCarIdx(frame: Telemetry): number | null {
    const cameraCarIdx = numberValue(frame, 'CamCarIdx');
    return cameraCarIdx !== null && cameraCarIdx >= 0
      ? cameraCarIdx
      : this.driverCarIdx;
  }

  private updateGreenFlag(
    sessionType: string | undefined,
    state: number,
    sessionTime: number,
    leaderCarIdx: number,
    leaderLap: number
  ): void {
    if (
      sessionType === 'Race' &&
      this.greenFlagTimestamp === null &&
      state === SessionState.Racing
    ) {
      if (
        this.previousSessionState !== null &&
        this.previousSessionState < SessionState.Racing
      ) {
        this.greenFlagTimestamp = sessionTime;
        this.lateJoin = false;
      } else if (this.previousSessionState === null) {
        this.lateJoin = true;
      }
    }
    if (
      this.lateJoin &&
      sessionType === 'Race' &&
      state === SessionState.Racing &&
      this.previousLeaderLap !== null &&
      leaderLap > this.previousLeaderLap &&
      leaderLap > 0
    ) {
      const averageLapTime = this.averageLapTime(leaderCarIdx);
      if (averageLapTime > 0) {
        this.greenFlagTimestamp = sessionTime - leaderLap * averageLapTime;
        this.lateJoin = false;
      }
    }
  }

  private calculateRaceValues(
    frame: Telemetry,
    sessionType: string | undefined,
    state: number,
    sessionTime: number,
    focusCarIdx: number | null,
    currentLap: number,
    leaderCarIdx: number,
    leaderLap: number,
    leaderLapDistPct: number,
    totalLaps: number,
    timeRemaining: number,
    timeTotal: number,
    fixedLapRace: boolean
  ): Pick<
    SessionTimingSnapshot,
    'totalRaceLaps' | 'leaderRaceLaps' | 'totalRaceTime' | 'adjustedRaceTime'
  > {
    // Canonical projection (src/shared/race-projection): timed races estimate
    // the focus car's total laps from when the overall leader takes the
    // checkered flag, at each car's own clean on-track pace. This keeps the
    // SessionBar lap counter, the fuel calculator and the title progress bar
    // on the same value, including multi-class timed races.
    const lapDistPct = numberValue(frame, 'LapDistPct') ?? 0;
    const focusBestLap = finiteAt(
      numberArray(frame, 'CarIdxBestLapTime'),
      focusCarIdx
    );
    const paceCarIdx = leaderCarIdx >= 0 ? leaderCarIdx : focusCarIdx;
    const leaderAvgLapTime = this.averageLapTime(paceCarIdx) || focusBestLap;
    const playerAvgLapTime = this.averageLapTime(focusCarIdx) || focusBestLap;
    const leaderPace = this.averageLapTime(paceCarIdx);
    const playerPace = this.averageLapTime(focusCarIdx);

    const leaderDist = leaderLap > 0 ? leaderLap - 1 + leaderLapDistPct : 0;
    const playerDist = currentLap > 0 ? currentLap - 1 + lapDistPct : 0;
    const elapsed = sessionTime - (this.greenFlagTimestamp ?? 0);

    const input: RaceProjectionInput = {
      sessionType,
      state,
      isFixedLapRace: fixedLapRace,
      totalLaps,
      timeRemaining,
      timeTotal,
      elapsed,
      playerLap: currentLap,
      playerLapDistPct: lapDistPct,
      leaderLap,
      leaderLapDistPct,
      leaderPace,
      playerPace,
      leaderPaceWall: elapsed > 0 && leaderDist > 0 ? elapsed / leaderDist : 0,
      playerPaceWall: elapsed > 0 && playerDist > 0 ? elapsed / playerDist : 0,
      leaderAvgLapTime,
      playerAvgLapTime,
      lastLeaderRaceLaps: this.lastLeaderRaceLaps,
    };
    const { totalRaceLaps, leaderRaceLaps, totalRaceTime, adjustedRaceTime } =
      calculateRaceProjection(input);
    return { totalRaceLaps, leaderRaceLaps, totalRaceTime, adjustedRaceTime };
  }

  private averageLapTime(carIdx: number | null): number {
    if (carIdx === null || carIdx < 0) return 0;
    const average = this.lapTimes()[carIdx] ?? 0;
    if (average > 0) return average;
    const driver = this.session?.DriverInfo?.Drivers?.find(
      (entry) => entry?.CarIdx === carIdx
    );
    const estimate = driver?.CarClassEstLapTime;
    return typeof estimate === 'number' && estimate > 1 ? estimate : 0;
  }

  private reset(sessionNum: number | null): void {
    const version = this.latest.version + 1;
    this.lastUpdateTime = null;
    this.previousSessionState = null;
    this.previousLeaderLap = null;
    this.greenFlagTimestamp = null;
    this.lastLeaderRaceLaps = 0;
    this.checkeredLap = null;
    this.lateJoin = false;
    this.latest = { ...this.emptySnapshot(), sessionNum, version };
  }

  private emptySnapshot(): SessionTimingSnapshot {
    return {
      state: 0,
      currentLap: 0,
      totalLaps: 0,
      time: 0,
      timeTotal: 0,
      timeRemaining: 0,
      greenFlagTimestamp: 0,
      isFixedLapRace: true,
      totalRaceLaps: 0,
      leaderRaceLaps: 0,
      totalRaceTime: 0,
      adjustedRaceTime: 0,
      sessionNum: null,
      version: 0,
    };
  }
}
