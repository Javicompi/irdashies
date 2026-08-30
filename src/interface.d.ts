import type {
  DashboardBridge,
  IrSdkBridge,
  IrSdkRawTelemetryBridge,
  PitLaneBridge,
  FuelCalculatorBridge,
  LogBridge,
  KeybindingsBridge,
  GamepadHostBridge,
  ChromiumFlagsBridge,
  OpenXRBridge,
  RaceControlBridge,
  TelemetryInspectorBridge,
  RendererPerfBridge,
} from '@irdashies/types';
import type { ChannelBridge } from '@irdashies/types';

declare global {
  interface Window {
    channelBridge: ChannelBridge;
    irsdkBridge: IrSdkBridge & IrSdkRawTelemetryBridge;
    telemetryInspectorBridge: TelemetryInspectorBridge;
    dashboardBridge: DashboardBridge;
    pitLaneBridge: PitLaneBridge;
    fuelCalculatorBridge: FuelCalculatorBridge;
    logBridge: LogBridge;
    keybindingsBridge: KeybindingsBridge;
    /** Present only in the hidden WebHID host renderer (src/hidHost.ts). */
    gamepadHost?: GamepadHostBridge;
    chromiumFlagsBridge: ChromiumFlagsBridge;
    /** OpenXR layer registration helpers (Settings > VR). */
    openxrBridge: OpenXRBridge;
    /** VR atlas page → main process layout reporter. */
    vrAtlasBridge?: {
      reportLayout: (
        layers: {
          widgetId: string;
          sourceRect: [number, number, number, number];
        }[]
      ) => void;
    };
    /** VR edit-mode state injected by the main process (VrAtlasContainer). */
    __vrEdit?: {
      active?: boolean;
      id?: string;
      x?: number;
      y?: number;
      z?: number;
    };
    raceControlBridge: RaceControlBridge;
    rendererPerfBridge?: RendererPerfBridge;
  }
}
