/**
 * Bridge to the main process OpenXR layer registration helpers.
 * Exposed to the renderer as `window.openxrBridge`.
 */
export interface OpenXRBridge {
  /** Whether the OpenXR layer is currently registered (no admin required). */
  checkLayer: () => Promise<boolean>;
  /** Register the OpenXR layer (requires admin, may prompt UAC). */
  registerLayer: () => Promise<boolean>;
  /** Unregister the OpenXR layer (requires admin, may prompt UAC). */
  unregisterLayer: () => Promise<boolean>;
}
