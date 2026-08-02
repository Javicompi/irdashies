import { useCallback, useEffect, useState } from 'react';
import { useDashboard } from '@irdashies/context';
import {
  DEFAULT_VR_OVERLAY_SETTINGS,
  type GeneralSettingsType,
  type VrOverlaySettings,
} from '@irdashies/types';
import { SettingNumberRow } from '../components/SettingNumberRow';
import { SettingToggleRow } from '../components/SettingToggleRow';
import { SettingsSection } from '../components/SettingSection';
import logger from '@irdashies/utils/logger';

type LayerStatus = 'checking' | 'registered' | 'missing';

export const VrSettings = () => {
  const { currentDashboard, onDashboardUpdated } = useDashboard();
  const [settings, setSettings] = useState({
    enabled:
      currentDashboard?.generalSettings?.vr?.enabled ??
      DEFAULT_VR_OVERLAY_SETTINGS.enabled,
    width:
      currentDashboard?.generalSettings?.vr?.width ??
      DEFAULT_VR_OVERLAY_SETTINGS.width,
    distance:
      currentDashboard?.generalSettings?.vr?.distance ??
      DEFAULT_VR_OVERLAY_SETTINGS.distance,
    horizontal:
      currentDashboard?.generalSettings?.vr?.horizontal ??
      DEFAULT_VR_OVERLAY_SETTINGS.horizontal,
    vertical:
      currentDashboard?.generalSettings?.vr?.vertical ??
      DEFAULT_VR_OVERLAY_SETTINGS.vertical,
  });
  const [layerStatus, setLayerStatus] = useState<LayerStatus>('checking');
  const [layerBusy, setLayerBusy] = useState(false);

  const refreshLayerStatus = useCallback(() => {
    if (!window.openxrBridge) return;
    setLayerStatus('checking');
    window.openxrBridge
      .checkLayer()
      .then((registered) => setLayerStatus(registered ? 'registered' : 'missing'))
      .catch((err) => {
        logger.error('Failed to check OpenXR layer', err);
        setLayerStatus('missing');
      });
  }, []);

  useEffect(() => {
    refreshLayerStatus();
  }, [refreshLayerStatus]);

  if (!currentDashboard || !onDashboardUpdated) {
    return <>Loading...</>;
  }

  const update = (partial: Partial<VrOverlaySettings>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    const generalSettings: GeneralSettingsType = {
      ...currentDashboard.generalSettings,
      vr: next,
    };
    onDashboardUpdated({ ...currentDashboard, generalSettings });
  };

  const runLayerAction = async (action: 'register' | 'unregister') => {
    if (!window.openxrBridge || layerBusy) return;
    setLayerBusy(true);
    try {
      if (action === 'register') {
        const ok = await window.openxrBridge.registerLayer();
        if (ok) {
          logger.info('OpenXR layer registered from Settings');
          setLayerStatus('registered');
        }
      } else {
        const ok = await window.openxrBridge.unregisterLayer();
        if (ok) {
          logger.info('OpenXR layer unregistered from Settings');
          setLayerStatus('missing');
        }
      }
    } catch (err) {
      logger.error(`Failed to ${action} OpenXR layer`, err);
    } finally {
      setLayerBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 bg-slate-700 rounded">
        <h2 className="text-xl mb-1">VR</h2>
        <p className="text-slate-400">
          Enable the VR overlay quad and configure its position and size. Enabling
          VR hides the desktop overlays; disabling it restores them.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 space-y-6 p-4 mt-4">
        <SettingsSection title="VR overlay">
          <SettingToggleRow
            title="Enable VR overlays"
            description="Shows the overlays in VR via the OpenXR layer and hides the desktop overlay windows."
            enabled={settings.enabled}
            onToggle={(enabled) => update({ enabled })}
          />

          <SettingNumberRow
            title="Width (m)"
            description="Physical width of the overlay quad. Height follows your display aspect."
            value={settings.width}
            min={0.5}
            max={4}
            step={0.01}
            onChange={(width) => update({ width })}
          />

          <SettingNumberRow
            title="Distance (m)"
            description="Distance of the overlay quad from the user."
            value={settings.distance}
            min={0.3}
            max={4}
            step={0.01}
            onChange={(distance) => update({ distance })}
          />

          <SettingNumberRow
            title="Horizontal offset (m)"
            description="Positive moves the quad to the right."
            value={settings.horizontal}
            min={-2}
            max={2}
            step={0.01}
            onChange={(horizontal) => update({ horizontal })}
          />

          <SettingNumberRow
            title="Vertical offset (m)"
            description="Positive moves the quad up."
            value={settings.vertical}
            min={-2}
            max={2}
            step={0.01}
            onChange={(vertical) => update({ vertical })}
          />
        </SettingsSection>

        <SettingsSection title="OpenXR layer">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-md font-medium text-slate-300">
                Layer status
              </h4>
              <p className="text-sm text-slate-500 pr-8">
                The OpenXR API layer must be registered for overlays to appear in
                VR. This requires administrator privileges.
              </p>
            </div>
            <span
              className={`text-sm font-medium ${
                layerStatus === 'registered'
                  ? 'text-green-400'
                  : layerStatus === 'checking'
                    ? 'text-slate-400'
                    : 'text-amber-400'
              }`}
            >
              {layerStatus === 'registered'
                ? 'Registered'
                : layerStatus === 'checking'
                  ? 'Checking...'
                  : 'Not registered'}
            </span>
          </div>

          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={() => runLayerAction('register')}
              disabled={layerBusy || layerStatus === 'registered'}
              className="px-3 py-1.5 rounded text-sm bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {layerBusy ? 'Working...' : 'Register layer'}
            </button>
            <button
              type="button"
              onClick={() => runLayerAction('unregister')}
              disabled={layerBusy || layerStatus !== 'registered'}
              className="px-3 py-1.5 rounded text-sm bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Unregister layer
            </button>
            <button
              type="button"
              onClick={refreshLayerStatus}
              disabled={layerBusy}
              className="px-3 py-1.5 rounded text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition-colors cursor-pointer"
            >
              Refresh
            </button>
          </div>
        </SettingsSection>

        <div className="p-4 bg-slate-700/50 rounded text-sm text-slate-300 space-y-2">
          <div className="font-medium mb-2">Edit Mode Shortcuts</div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <span className="font-bold text-slate-200">Ctrl+Shift+F9</span>
              <span className="text-slate-400">Enter / exit edit mode</span>
            </div>
            <div className="flex justify-between">
              <span className="font-bold text-slate-200">Arrow keys</span>
              <span className="text-slate-400">Move selected overlay</span>
            </div>
            <div className="flex justify-between">
              <span className="font-bold text-slate-200">Space</span>
              <span className="text-slate-400">Cycle between overlays</span>
            </div>
            <div className="flex justify-between">
              <span className="font-bold text-slate-200">Q / E</span>
              <span className="text-slate-400">Adjust overlay distance</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
