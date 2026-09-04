import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { FuelCalculator } from './FuelCalculator';
import { useTelemetryStore, DashboardProvider } from '@irdashies/context';
import type { ChannelName, ChannelPayloads } from '@irdashies/types';

const subscriberCallbacks = new Map<string, (snapshot: unknown) => void>();

const fakeChannelBridge = {
  subscribe: (channel: string, callback: (snapshot: unknown) => void) => {
    subscriberCallbacks.set(channel, callback);
    return () => subscriberCallbacks.delete(channel);
  },
};

const fakeDashboardBridge = {
  onDashboardUpdated: () => () => undefined,
  dashboardUpdated: () => () => undefined,
  onEditModeToggled: () => () => undefined,
  onContainerBoundsInfo: () => () => undefined,
  onNavigateToSettings: () => () => undefined,
  onDemoModeChanged: () => () => undefined,
  listProfiles: async () => [],
  getCurrentProfile: async () => ({ id: 'default', name: 'default' }),
  getDashboardForProfile: async () => undefined,
  getCurrentDashboard: () => null,
  getAppVersion: async () => 'test',
  getComponentServerPort: async () => 3000,
  getCycleProfiles: async () => false,
  setCycleProfiles: async () => undefined,
  getShowProfileBanner: async () => false,
  setShowProfileBanner: async () => undefined,
  getDriverTagSettings: async () => ({}),
  saveDriverTagSettings: async () => undefined,
  getAnalyticsOptOut: async () => true,
  setAnalyticsOptOut: async () => undefined,
  getGarageCoverImageAsDataUrl: async () => undefined,
  saveGarageCoverImage: async () => undefined,
  getPlayerIconImageAsDataUrl: async () => undefined,
  savePlayerIconImage: async () => undefined,
  saveDashboard: () => undefined,
  resetDashboard: async () => undefined,
  toggleLockOverlays: async () => undefined,
  toggleDemoMode: () => undefined,
  setAutoStart: async () => undefined,
  openWidgetSettings: async () => undefined,
  exportDashboardToFile: async () => undefined,
  importDashboardFromFile: async () => undefined,
  openLogFolder: async () => undefined,
  exportLogFile: async () => undefined,
  reloadDashboard: () => undefined,
  stop: () => undefined,
  createProfile: async () => ({ id: 'p', name: 'p' }),
  cloneProfile: async () => ({ id: 'p', name: 'p' }),
  deleteProfile: async () => undefined,
  renameProfile: async () => undefined,
  switchProfile: async () => undefined,
  getCurrentProfileId: async () => 'default',
  updateProfileTheme: async () => undefined,
} as never;

const publish = <K extends ChannelName>(
  channel: K,
  payload: ChannelPayloads[K]
) => {
  subscriberCallbacks.get(channel)?.(payload);
};

const telemetryFrame = (overrides: Record<string, { value: unknown }> = {}) => {
  const base: Record<string, { value: unknown }> = {
    FuelLevel: { value: [45] },
    FuelLevelPct: { value: [0.75] },
    Lap: { value: [1] },
    LapDistPct: { value: [0.3] },
    SessionLapsRemain: { value: [20] },
    SessionTimeRemain: { value: [1800] },
    SessionTimeTotal: { value: [7200] },
    SessionFlags: { value: [0] },
    SessionTime: { value: [10] },
    SessionNum: { value: [2] },
    SessionState: { value: [4] },
    OnPitRoad: { value: [false] },
    IsOnTrack: { value: [true] },
    PlayerCarTowTime: { value: [0] },
    CarIdxLap: { value: [1, 1] },
    CarIdxPosition: { value: [2, 1] },
    CarIdxLapDistPct: { value: [0.3, 0.5] },
    CarIdxBestLapTime: { value: [0, 0] },
    CarIdxLastLapTime: { value: [0, 0] },
    CamCarIdx: { value: [-1] },
  };
  return { ...base, ...overrides } as never;
};

const userSettings = {
  showOnlyWhenOnTrack: true,
  fuelUnits: 'L' as const,
  layout: 'vertical' as const,
  safetyMargin: 0,
  background: { opacity: 85 },
  fuelRequiredMode: 'toFinish' as const,
  enableStorage: false,
  enableLogging: false,
  showFuelStatusBorder: false,
  useGeneralFontSize: false,
  useGeneralCompactMode: false,
  sessionVisibility: {
    race: true,
    loneQualify: true,
    openQualify: true,
    practice: true,
    offlineTesting: true,
  },
  layoutTree: {
    id: 'box-1',
    type: 'box',
    direction: 'col' as const,
    children: [
      {
        id: 'box-1',
        type: 'box',
        direction: 'col' as const,
        widgets: ['fuelHeader', 'fuelGauge', 'fuelGrid'],
      },
    ],
    widgets: ['fuelGraph', 'fuelGauge', 'fuelGrid', 'fuelLaps'],
  },
  widgetStyles: {},
};

describe('FuelCalculator race-start stability', () => {
  beforeEach(() => {
    subscriberCallbacks.clear();
    vi.stubGlobal('channelBridge', fakeChannelBridge);
    window.channelBridge = fakeChannelBridge as never;
    useTelemetryStore.getState().resetTelemetry();
  });

  it('does not hit a render-phase update loop when the widget subtree remounts at race start', async () => {
    const { unmount } = render(
      <DashboardProvider bridge={fakeDashboardBridge}>
        <FuelCalculator {...(userSettings as unknown as object)} />
      </DashboardProvider>
    );

    // Phase 1: quali — widget hidden (isOnTrack=false), channels flowing.
    const publishTiming = (isOnTrack: boolean, tick: number) => {
      publish('session-timing.snapshot', {
        sessionType: 'Open Qualify',
        state: 2,
        currentLap: 8,
        totalLaps: 0,
        time: tick,
        timeTotal: 900,
        timeRemaining: 600,
        greenFlagTimestamp: 0,
        isFixedLapRace: false,
        totalRaceLaps: 0,
        totalRaceTime: 0,
        adjustedRaceTime: 0,
        sessionNum: 1,
        version: tick,
      });
      publish('fuel.projection', {
        isReplay: false,
        fuelLevel: 45,
        fuelLevelPct: 0.75,
        currentLap: 8,
        lapDistPct: 0.5,
        currentLapUsage: 0.1,
        projectedLapUsage: 2.4,
        lastLapUsage: 2.4,
        sessionLapsRemain: 0,
        sessionTimeRemain: 600,
        sessionTimeTotal: 900,
        sessionFlags: 0,
        sessionState: 2,
        sessionNum: 1,
        sessionLaps: 0,
        calculatedTotalRaceLaps: 0,
        estimatedLapsRemaining: 0,
        hasValidRaceEstimate: false,
        isFixedLapRace: false,
        isOnTrack,
        completedLaps: [],
        engine: {
          accumulatedRefuel: 0,
          isLapDistPctReset: false,
          lapCrossingTime: 0,
          lapStartFuel: 45,
          lastLap: 8,
          lastLapDistPct: 0.5,
          lastSessionFlags: 0,
          wasOnPitRoad: false,
        },
      });
      publish('lap-times.snapshot', {
        lapTimes: [115],
        lapTimeHistory: [[115]],
        sessionNum: 1,
        version: tick,
      });
    };

    let crashed = false;
    try {
      for (let tick = 1; tick < 120; tick++) {
        act(() => {
          useTelemetryStore.getState().setTelemetry(
            telemetryFrame({
              SessionNum: { value: [1] },
              SessionState: { value: [2] },
              SessionTime: { value: [tick] },
              SessionLapsRemain: { value: [0] },
              IsOnTrack: { value: [false] },
              Lap: { value: [8] },
            }) as never
          );
          publishTiming(false, tick);
        });
      }

      // Phase 2: race start — isOnTrack flips, the hidden subtree remounts,
      // all channels burst (empty-reset then live values), telemetry at 60Hz.
      for (let tick = 1; tick < 400; tick++) {
        act(() => {
          useTelemetryStore.getState().setTelemetry(
            telemetryFrame({
              SessionNum: { value: [2] },
              SessionState: { value: [4] },
              SessionTime: { value: [tick] },
              Lap: { value: [1] },
              CarIdxLap: { value: [1, 1] },
              IsOnTrack: { value: [true] },
            }) as never
          );
          publish('session-timing.snapshot', {
            sessionType: 'Race',
            state: 4,
            currentLap: 1,
            totalLaps: 20,
            time: tick,
            timeTotal: 7200,
            timeRemaining: 7200 - tick,
            greenFlagTimestamp: 0,
            isFixedLapRace: true,
            totalRaceLaps: 20,
            totalRaceTime: 3600,
            adjustedRaceTime: 3600,
            sessionNum: 2,
            version: tick,
          });
          publish('fuel.projection', {
            isReplay: false,
            fuelLevel: 45 - tick * 0.01,
            fuelLevelPct: 0.75,
            currentLap: 1,
            lapDistPct: (tick % 100) / 100,
            currentLapUsage: 0.1,
            projectedLapUsage: 2.4,
            lastLapUsage: 2.4,
            sessionLapsRemain: 20,
            sessionTimeRemain: 7200 - tick,
            sessionTimeTotal: 7200,
            sessionFlags: 0,
            sessionState: 4,
            sessionNum: 2,
            sessionLaps: 20,
            calculatedTotalRaceLaps: 20,
            estimatedLapsRemaining: 19,
            hasValidRaceEstimate: true,
            isFixedLapRace: true,
            isOnTrack: true,
            completedLaps: [],
            engine: {
              accumulatedRefuel: 0,
              isLapDistPctReset: false,
              lapCrossingTime: 0,
              lapStartFuel: 45,
              lastLap: 1,
              lastLapDistPct: 0.3,
              lastSessionFlags: 0,
              wasOnPitRoad: false,
            },
          });
          publish('lap-times.snapshot', {
            lapTimes: [118, 0],
            lapTimeHistory: [[118]],
            sessionNum: 2,
            version: tick,
          });
        });
        if (tick % 30 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      crashed = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Maximum update depth');
    }

    unmount();
    expect(crashed).toBe(false);
  });
});
