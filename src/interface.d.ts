import type {
  DashboardBridge,
  IrSdkBridge,
  PitLaneBridge,
  FuelCalculatorBridge,
  ReferenceLapBridge,
  LogBridge,
  KeybindingsBridge,
  GamepadHostBridge,
  ChromiumFlagsBridge,
  OpenXRBridge,
} from '@irdashies/types';

declare global {
  interface Window {
    irsdkBridge: IrSdkBridge;
    dashboardBridge: DashboardBridge;
    pitLaneBridge: PitLaneBridge;
    fuelCalculatorBridge: FuelCalculatorBridge;
    referenceLapsBridge: ReferenceLapBridge;
    logBridge: LogBridge;
    keybindingsBridge: KeybindingsBridge;
    /** Present only in the hidden WebHID host renderer (src/hidHost.ts). */
    gamepadHost?: GamepadHostBridge;
    chromiumFlagsBridge: ChromiumFlagsBridge;
    /** OpenXR layer registration helpers (Settings > VR). */
    openxrBridge: OpenXRBridge;
    /** VR atlas page → main process layout reporter. */
    vrAtlasBridge?: {
      reportLayout: (layers: { widgetId: string; sourceRect: [number, number, number, number] }[]) => void;
    };
    /** VR edit-mode state injected by the main process (VrAtlasContainer). */
    __vrEdit?: { active?: boolean; id?: string; x?: number; y?: number; z?: number };
  }
}
