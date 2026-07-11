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
    /** VR atlas page → main process layout reporter. */
    vrAtlasBridge?: {
      reportLayout: (layers: { widgetId: string; sourceRect: [number, number, number, number] }[]) => void;
    };
    vrEditBridge?: {
      onEditMode: (cb: (active: boolean, selectedId: string | null, position: [number, number, number]) => void) => () => void;
      onSelect: (cb: (widgetId: string, position: [number, number, number]) => void) => () => void;
      onMove: (cb: (position: [number, number, number]) => void) => () => void;
    };
  }
}
