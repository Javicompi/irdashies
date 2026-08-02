/**
 * Bridge to the main process OpenXR layer registration helpers.
 * Exposed to the renderer as `window.openxrBridge`.
 */
export interface OpenXRBridge {
  /**
   * Whether the OpenXR layer is currently registered (no admin required).
   * Returns `null` when the registration script/DLL cannot be located, i.e.
   * the status cannot be verified (the layer may still be registered).
   */
  checkLayer: () => Promise<boolean | null>;
  /** Register the OpenXR layer (requires admin, may prompt UAC). */
  registerLayer: () => Promise<boolean>;
  /** Unregister the OpenXR layer (requires admin, may prompt UAC). */
  unregisterLayer: () => Promise<boolean>;
}
