import { describe, expect, it } from 'vitest';
import type { Session, Telemetry } from '@irdashies/types';
import { SessionState } from '@irdashies/types';
import { SessionTimingProcessor } from './SessionTimingProcessor';

const session = {
  DriverInfo: {
    DriverCarIdx: 1,
    Drivers: [{ CarIdx: 0, CarClassEstLapTime: 60 }, { CarIdx: 1 }],
  },
  SessionInfo: {
    Sessions: [{ SessionNum: 0, SessionType: 'Race', SessionLaps: 10 }],
  },
} as unknown as Session;

const frame = (overrides: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries({
      SessionTime: 20,
      SessionNum: 0,
      SessionState: SessionState.Racing,
      SessionTimeTotal: 600,
      SessionTimeRemain: 604800,
      CamCarIdx: 1,
      LapDistPct: 0.25,
      CarIdxLap: [2, 2],
      CarIdxPosition: [1, 2],
      CarIdxLapDistPct: [0.5, 0.25],
      CarIdxBestLapTime: [60, 61],
      CarIdxLapCompleted: [1, 1],
      CarIdxLastLapTime: [60, 61],
      ...overrides,
    }).map(([key, value]) => [
      key,
      { value: Array.isArray(value) ? value : [value] },
    ])
  ) as unknown as Telemetry;

describe('SessionTimingProcessor', () => {
  it('projects fixed-lap timing for the focused car', () => {
    const processor = new SessionTimingProcessor(() => [60, 61]);
    processor.init(session);
    processor.onFrame(frame());
    expect(processor.snapshot()).toMatchObject({
      sessionType: 'Race',
      state: SessionState.Racing,
      currentLap: 2,
      totalLaps: 10,
      isFixedLapRace: true,
      totalRaceLaps: 10,
      totalRaceTime: 600,
      adjustedRaceTime: 600,
      sessionNum: 0,
    });
  });

  it('captures the green transition and freezes the lap at checkered', () => {
    const processor = new SessionTimingProcessor();
    processor.init(session);
    processor.onFrame(
      frame({ SessionTime: 10, SessionState: SessionState.Warmup })
    );
    processor.onFrame(
      frame({ SessionTime: 11, SessionState: SessionState.Racing })
    );
    expect(processor.snapshot().greenFlagTimestamp).toBe(11);
    processor.onFrame(
      frame({
        SessionTime: 12,
        SessionState: SessionState.Checkered,
        CarIdxLap: [3, 3],
      })
    );
    processor.onFrame(
      frame({
        SessionTime: 13,
        SessionState: SessionState.Checkered,
        CarIdxLap: [4, 4],
      })
    );
    expect(processor.snapshot().currentLap).toBe(3);
    expect(processor.snapshot().totalRaceLaps).toBe(3);
  });

  it('projects timed multi-class totals from the overall leader pace', () => {
    // Timed 2h race: overall leader (faster class, car 0) 115.13s pace,
    // focus car (slower class, car 1) 134.0s pace. Canonical projection:
    // timeToCompleteCurrentLap=(1-0.26)*115.13=85.2 < remain=200
    // lapsUntilCheckered=1, leaderRemainingTime=200.33
    // playerTotalLaps=52.203+200.33/134=53.70
    const timedSession = {
      DriverInfo: {
        DriverCarIdx: 1,
        Drivers: [{ CarIdx: 0 }, { CarIdx: 1 }],
      },
      SessionInfo: {
        Sessions: [
          { SessionNum: 0, SessionType: 'Race', SessionLaps: 'unlimited' },
        ],
      },
    } as unknown as Session;
    const processor = new SessionTimingProcessor(() => [115.13, 134.0]);
    processor.init(timedSession);
    processor.onFrame(
      frame({
        SessionTime: 0,
        SessionState: SessionState.Warmup,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 7200,
        CarIdxLap: [1, 1],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0, 0],
        LapDistPct: 0,
      })
    );
    processor.onFrame(
      frame({
        SessionTime: 0.3,
        SessionState: SessionState.Racing,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 7199.7,
        CamCarIdx: 1,
        LapDistPct: 0,
        CarIdxLap: [1, 1],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0, 0],
      })
    );
    processor.onFrame(
      frame({
        SessionTime: 7000,
        SessionState: SessionState.Racing,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 200,
        CamCarIdx: 1,
        LapDistPct: 0.203,
        CarIdxLap: [61, 53],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0.26, 0.203],
      })
    );
    const snapshot = processor.snapshot();
    expect(snapshot.isFixedLapRace).toBe(false);
    expect(snapshot.totalRaceLaps).toBeCloseTo(53.7, 1);
    expect(snapshot.leaderRaceLaps).toBeCloseTo(62.0, 1);
  });

  it('timed race with the clock at 0 is not treated as fixed-lap', () => {
    const timedSession = {
      DriverInfo: {
        DriverCarIdx: 1,
        Drivers: [{ CarIdx: 0 }, { CarIdx: 1 }],
      },
      SessionInfo: {
        Sessions: [
          { SessionNum: 0, SessionType: 'Race', SessionLaps: 'unlimited' },
        ],
      },
    } as unknown as Session;
    const processor = new SessionTimingProcessor(() => [115.13, 134.0]);
    processor.init(timedSession);
    processor.onFrame(
      frame({
        SessionTime: 0,
        SessionState: SessionState.Warmup,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 7200,
        CarIdxLap: [1, 1],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0, 0],
        LapDistPct: 0,
      })
    );
    processor.onFrame(
      frame({
        SessionTime: 0.3,
        SessionState: SessionState.Racing,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 7199.7,
        CamCarIdx: 1,
        LapDistPct: 0,
        CarIdxLap: [1, 1],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0, 0],
      })
    );
    processor.onFrame(
      frame({
        SessionTime: 7457,
        SessionState: SessionState.Racing,
        SessionTimeTotal: 7200,
        SessionTimeRemain: 0,
        CamCarIdx: 1,
        LapDistPct: 0.203,
        CarIdxLap: [61, 53],
        CarIdxPosition: [1, 2],
        CarIdxLapDistPct: [0.26, 0.203],
      })
    );
    const snapshot = processor.snapshot();
    expect(snapshot.isFixedLapRace).toBe(false);
    // leaderRemainingTime=(1-0.26)*115.13=85.2, 52.203+85.2/134=52.84
    expect(snapshot.totalRaceLaps).toBeCloseTo(52.8, 1);
    expect(snapshot.leaderRaceLaps).toBeCloseTo(60.3, 1);
  });

  it('resets on session changes and ignores replay scrubbing', () => {
    const processor = new SessionTimingProcessor();
    processor.init(session);
    processor.onFrame(frame());
    processor.onLifecycle({ type: 'sessionNumChange' });
    expect(processor.snapshot()).toMatchObject({
      sessionNum: null,
      currentLap: 0,
    });
    processor.onLifecycle({ type: 'enter', replay: true });
    processor.onFrame(frame({ SessionTime: 30 }));
    expect(processor.snapshot().currentLap).toBe(0);
  });
});
