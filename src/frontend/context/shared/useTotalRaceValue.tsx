import { useSessionLapCount } from '../../components/Standings/hooks/useSessionLapCount';
import {
    useCurrentSessionType,
    useCarIdxClassEstLapTime,
    useFocusCarIdx,
    useTelemetryValue,
    useTelemetryValues,
    useTelemetryValuesRounded,
    useLapTimesStoreUpdater,
} from '@irdashies/context';
import { useCarIdxAverageLapTime } from './useCarIdxAverageLapTime';
import { SessionState } from '@irdashies/types';

// Estimate the total number of laps that will be completed by the drivers car in a timed session.
export const useTotalRaceValue = () => {
    const carIdx = useFocusCarIdx() as number;
    const { timeRemaining, timeTotal, totalLaps, state, time, greenFlagTimestamp } = useSessionLapCount();
    const lap = useTelemetryValues('CarIdxLap')?.[carIdx] as number;
    const sessionType = useCurrentSessionType();
    const lapDistPct = useTelemetryValue('LapDistPct');
    const carIdxLap = useTelemetryValues('CarIdxLap');
    const carIdxPosition = useTelemetryValues('CarIdxPosition');
    const carIdxLapDistPct = useTelemetryValuesRounded('CarIdxLapDistPct', 3);
    const avgLapTimes = useCarIdxAverageLapTime();
    const bestLapTime = useTelemetryValues('CarIdxBestLapTime')?.[carIdx] as number | undefined;
    const classEstLapTimes = useCarIdxClassEstLapTime();
    const isFixedLapRace = !((timeRemaining > 0) && (timeRemaining !== 604800));

    // Ensure the lap-time store is being populated whenever a race widget that
    // depends on this projection is rendered. Without this, the store stays
    // cold (no widget enabled `lapTimeDeltas` / `avgLapTime`) and the projection
    // silently falls back to iRacing `CarClassEstLapTime` (qualifying-class
    // pace), which over-estimates total laps for multi-class timed races
    // (user-reported 55+ vs actual 53).
    // Must run before the early return below (React hook rules).
    useLapTimesStoreUpdater(sessionType === 'Race');

    const result = {
        isFixedLapRace: isFixedLapRace,
        totalRaceLaps: 0,
        totalRaceTime: 0,
        adjustedRaceTime: 0,
    };

    // No race, no business
    if (sessionType !== 'Race') return result;

    let leaderCarIdx = -1;
    let leaderLap = 0;
    let leaderLapDistPct = 0;
    for (let i = 0; i < carIdxPosition.length; i++) {
        if (carIdxPosition[i] === 1 && carIdxLap[i] !== undefined && carIdxLapDistPct[i] !== undefined) {
            leaderCarIdx = i;
            leaderLap = carIdxLap[i] ?? 0;
            leaderLapDistPct = carIdxLapDistPct[i] ?? 0;
            break;
        }
    }
    // Lap time for the race clock in fixed-lap races: use the leader's pace,
    // since the race ends when the leader completes the total laps.
    const leaderLapTimeIdx = leaderCarIdx >= 0 ? leaderCarIdx : carIdx;
    const leaderAvgLapTime =
        (avgLapTimes[leaderLapTimeIdx] > 0)
            ? avgLapTimes[leaderLapTimeIdx]
            : (classEstLapTimes?.[leaderLapTimeIdx] ?? 0) > 0 && classEstLapTimes?.[leaderLapTimeIdx] !== undefined
                ? classEstLapTimes?.[leaderLapTimeIdx]
                : (bestLapTime ?? 0);

    // Lap time for estimating the player's total laps in timed races.
    // Fallbacks: class estimated lap time, then best lap time.
    const playerAvgLapTime =
        (avgLapTimes[carIdx] > 0)
            ? avgLapTimes[carIdx]
            : (classEstLapTimes?.[carIdx] ?? 0) > 0 && classEstLapTimes?.[carIdx] !== undefined
                ? classEstLapTimes?.[carIdx]
                : (bestLapTime ?? 0);


    if (isFixedLapRace) {
        // Easy case, fixed lap count. We just have to account for the race leader that might have lapped us
        result.totalRaceLaps = totalLaps;

        const lapsValid = lap !== undefined &&
            leaderLap !== undefined &&
            lapDistPct !== undefined &&
            leaderLapDistPct !== undefined &&
            lap > 0 &&
            leaderLap > 0;
        if (lapsValid) {
            const totalDist = lap + lapDistPct;
            const totalLeaderDist = leaderLap + leaderLapDistPct;

            if (totalLeaderDist > totalDist) {
                result.totalRaceLaps -= Math.floor(totalLeaderDist - totalDist);
            }
        }

        // Race clock: based on leader's pace (race ends when leader finishes)
        if (leaderAvgLapTime > 0) {
            result.totalRaceTime = totalLaps * leaderAvgLapTime;
            result.adjustedRaceTime = result.totalRaceTime;

            if (lapsValid) {
                const totalDist = lap + lapDistPct;
                const totalLeaderDist = leaderLap + leaderLapDistPct;
                if (totalLeaderDist > totalDist) {
                    result.adjustedRaceTime =
                        (totalLaps - Math.floor(totalLeaderDist - totalDist)) * leaderAvgLapTime;
                }
            }
        }
    } else {
        // Time-limited race: estimate based on when the leader will receive the checkered flag.
        // Uses the observed wall-clock pace (distance travelled since the green flag),
        // which inherently includes each car's pit stop losses — unlike the lap-time
        // average (on-track pace only). This matters in multi-class timed races where
        // pit strategies differ (e.g. leader 1 stop vs player 2 stops).
        //   1. wall-clock pace per car = elapsed time / distance travelled
        //   2. leaderFinalLap = laps the leader will complete (checkered-flag moment)
        //   3. effective race duration = leaderFinalLap * leaderPaceWall
        //   4. playerTotalLaps = effectiveRaceTime / playerPaceWall (rounded to 1dp)
        result.totalRaceTime = timeTotal;

        const elapsed = (time ?? 0) - (greenFlagTimestamp ?? 0);
        const leaderDist = leaderLap > 0 ? leaderLap - 1 + leaderLapDistPct : 0;
        const playerDist = lap !== undefined && lap > 0 ? lap - 1 + (lapDistPct ?? 0) : 0;

        const leaderPaceWall = elapsed > 0 && leaderDist > 0 ? elapsed / leaderDist : 0;
        const playerPaceWall = elapsed > 0 && playerDist > 0 ? elapsed / playerDist : 0;

        if (
            timeRemaining !== undefined &&
            timeRemaining >= 0 &&
            leaderPaceWall > 1 &&
            playerPaceWall > 1
        ) {
            const leaderFinalLap = Math.ceil((elapsed + timeRemaining) / leaderPaceWall);
            const effectiveRaceTime = leaderFinalLap * leaderPaceWall;
            result.totalRaceLaps = Math.round((effectiveRaceTime / playerPaceWall) * 10) / 10;
        } else if (timeTotal > 0 && leaderAvgLapTime > 1 && playerAvgLapTime > 1) {
            // Fallback (e.g. green flag not observed yet): pace-based estimate.
            const leaderEstimatedLaps = Math.ceil(timeTotal / leaderAvgLapTime);
            const effectiveRaceTime = leaderEstimatedLaps * leaderAvgLapTime;
            result.totalRaceLaps = Math.round((effectiveRaceTime / playerAvgLapTime) * 10) / 10;
        }

        if ((totalLaps ?? 0) > 0 && result.totalRaceLaps > totalLaps) {
            result.totalRaceLaps = totalLaps;
        }
    }

    if (state >= SessionState.Checkered) {
        // After checkered: freeze at the lap count captured when the flag was shown
        return {
            isFixedLapRace: isFixedLapRace,
            totalRaceLaps: lap,
            totalRaceTime: result.totalRaceTime,
            adjustedRaceTime: result.adjustedRaceTime
        };
    }

    return result;
};
