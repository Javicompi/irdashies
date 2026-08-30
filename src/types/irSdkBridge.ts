import type { Session, Telemetry } from '@irdashies/types';

export enum ReplayPositionCommand {
  /** Beginning of the replay */
  Begin = 0,
  /** Current position in the replay */
  Current,
  /** End of the replay */
  End,
  /** Unused */
  Last,
}

export interface IrSdkBridge {
  onSessionData: (
    callback: (value: Session) => void
  ) => (() => void) | undefined;
  onRunningState: (
    callback: (value: boolean) => void
  ) => (() => void) | undefined;
  stop: () => void;
}

/**
 * Renderer-side raw telemetry subscription (fork addition). The upstream
 * renderer API deliberately excludes raw telemetry (all widgets consume typed
 * channels), but the fork's renderer-side widgets (fuel calculator, VR atlas,
 * input trace) still subscribe to it. The exposed irsdkBridge adds this
 * subscription, gated per window by the renderer-data subscription registry.
 */
export interface IrSdkRawTelemetryBridge {
  onTelemetry: (
    callback: (value: Telemetry) => void
  ) => (() => void) | undefined;
}

/**
 * Main-process SDK source. Raw telemetry and the broadcast commands are not
 * part of the normal renderer API - the renderer drives those through
 * `raceControlBridge`.
 */
export interface IrSdkSourceBridge extends IrSdkBridge {
  onTelemetry: (
    callback: (value: Telemetry) => void
  ) => (() => void) | undefined;
  changeCameraNumber: (
    carNumber: string,
    group: number,
    camera: number
  ) => void;
  changeReplayPosition: (
    position: ReplayPositionCommand,
    frame: number
  ) => void;
  triggerReplaySessionSearch: (
    sessionNum: number,
    sessionTimeMs: number
  ) => void;
}
