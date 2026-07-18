import { useSessionLapCount } from '../../components/Standings/hooks/useSessionLapCount';
import {
    useCurrentSessionType,
    useCarIdxClassEstLapTime,
    useFocusCarIdx,
    useTelemetryValue,
    useTelemetryValues,
    useTelemetryValuesRounded,
} from '@irdashies/context';
import { useCarIdxAverageLapTime } from './useCarIdxAverageLapTime';
import { SessionState } from '@irdashies/types';

// Estimate the total number of laps that will be completed by the drivers car in a timed session.
export const useTotalRaceValue = () => {
    const carIdx = useFocusCarIdx() as number;
    const { timeRemaining, timeTotal, totalLaps, state } = useSessionLapCount();
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
        // 1. ceil(timeTotal / leaderAvgLapTime) = laps the leader will complete
        // 2. effective race duration = leaderEstimatedLaps * leaderAvgLapTime
        // 3. playerTotalLaps = effectiveRaceTime / playerAvgLapTime (rounded to 1dp)
        result.totalRaceTime = timeTotal;

        if (timeTotal > 0 && leaderAvgLapTime > 1 && playerAvgLapTime > 1) {
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
