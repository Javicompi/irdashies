export interface VrPose {
  /** position in metres, LOCAL space */
  position?: [number, number, number];
  /** orientation quaternion x,y,z,w */
  orientation?: [number, number, number, number];
  /** quad size in metres, width,height */
  size?: [number, number];
}

export interface LayerConfig {
  /** position in metres, LOCAL space */
  position: [number, number, number];
  /** orientation quaternion x,y,z,w */
  orientation: [number, number, number, number];
  /** quad size in metres, width,height */
  size: [number, number];
  /** sub-rect in atlas texels: x, y, w, h */
  sourceRect: [number, number, number, number];
  /** opacity 0..1 */
  opacity: number;
  /** 0 = hidden, 1 = visible */
  visible: number;
}

export interface IVrOverlayNative {
  /** Initialise the D3D11 device, shared fence and shared memory. */
  start(pose?: VrPose): boolean;
  /**
   * Copy an Electron offscreen shared texture into the shared texture and
   * publish it. Pass `event.texture.textureInfo` from a `paint` event.
   */
  submitFrame(textureInfo: unknown): boolean;
  /** Update the quad pose without restarting. */
  setPose(pose: VrPose): void;
  /** Publish the per-widget layer table (poses, sub-rects, opacity). */
  setLayers(layers: LayerConfig[]): void;
  /** Request the OpenXR layer to recenter the quad to the current head pose. */
  recenter(): void;
  /** Release all resources and detach the feeder. */
  stop(): void;
}

export const VrOverlayNative: IVrOverlayNative;
