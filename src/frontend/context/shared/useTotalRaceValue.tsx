import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useSessionTimingStore } from '../SessionTimingStore/SessionTimingStore';

/**
 * @deprecated Canonical race-lap projection now lives in the main-process
 * `SessionTimingProcessor` (`src/shared/race-projection`) and is delivered
 * over the `session-timing.snapshot` channel. This hook is a thin selector
 * over that store so the fuel calculator, the SessionBar lap counter and the
 * title progress bar all read the same value.
 *
 * Estimate semantics (timed races): the focus car's total laps projected from
 * when the overall leader takes the checkered flag, at each car's own clean
 * on-track pace. See `calculateRaceProjection`.
 */
export const useTotalRaceValue = () =>
  useStoreWithEqualityFn(
    useSessionTimingStore,
    (s) => ({
      isFixedLapRace: s.isFixedLapRace,
      totalRaceLaps: s.totalRaceLaps,
      totalRaceTime: s.totalRaceTime,
      adjustedRaceTime: s.adjustedRaceTime,
      leaderRaceLaps: s.leaderRaceLaps,
    }),
    shallow
  );
