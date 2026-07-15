import { useState } from 'react';
import { useDashboard } from '@irdashies/context';
import {
  DEFAULT_VR_OVERLAY_SETTINGS,
  type GeneralSettingsType,
  type VrOverlaySettings,
} from '@irdashies/types';
import { SettingNumberRow } from '../components/SettingNumberRow';

export const VrSettings = () => {
  const { currentDashboard, onDashboardUpdated } = useDashboard();
  const [settings, setSettings] = useState({
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 bg-slate-700 rounded">
        <h2 className="text-xl mb-1">VR</h2>
        <p className="text-slate-400">
          Configure the VR overlay quad position and size. Launch the app with{' '}
          <code className="bg-slate-600 px-1 rounded">launch-vr.bat</code> to
          enable VR mode.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 space-y-6 p-4 mt-4">
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
