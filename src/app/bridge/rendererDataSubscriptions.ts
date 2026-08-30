import { defineRendererSubscriptionBridge } from './defineBridge';

export const RENDERER_DATA_SUBSCRIPTION_BRIDGE = 'renderer-data';

export type RendererDataStream =
  'sessionData' | 'telemetryInspector' | 'telemetry';

export const isRendererDataStream = (
  value: unknown
): value is RendererDataStream =>
  value === 'sessionData' ||
  value === 'telemetryInspector' ||
  value === 'telemetry';

export const setupRendererDataSubscriptions = () =>
  defineRendererSubscriptionBridge<RendererDataStream>({
    name: RENDERER_DATA_SUBSCRIPTION_BRIDGE,
    isValidKey: isRendererDataStream,
  });
