import { memo, useEffect, useMemo, useState } from 'react';
import { useDashboard, useRunningState } from '@irdashies/context';
import { getWidget } from '../../WidgetIndex';
import { WidgetContainer } from '../WidgetContainer';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';
import { VrEditInstructions } from './VrEditInstructions';

const noop = () => {
  // VR atlas widgets are not draggable; no-op for the required prop.
};

interface AtlasSlot {
  widgetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const VrAtlasContainer = memo(() => {
  const { currentDashboard } = useDashboard();
  const { running } = useRunningState();

  const [editMode, setEditMode] = useState(false);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [, setLivePosition] = useState<[number, number, number]>([0, 0, -1.5]);

  useEffect(() => {
    if (!window.vrEditBridge) return;
    const unmode = window.vrEditBridge.onEditMode((active, id, pos) => {
      setEditMode(active);
      setSelectedWidgetId(id || null);
      setLivePosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]);
    });
    const unsel = window.vrEditBridge.onSelect((id, pos) => {
      setSelectedWidgetId(id || null);
      setLivePosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]);
    });
    const unmove = window.vrEditBridge.onMove((pos) => {
      setLivePosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]);
    });
    return () => { unmode(); unsel(); unmove(); };
  }, []);

  // All enabled widgets; vrEnabled defaults to true (matches pre-P2 behaviour).
  // Sort by desktop layout position (top-left to bottom-right) so the visual
  // order matches what the user configured.
  const vrWidgets = useMemo(
    () =>
      (currentDashboard?.widgets ?? [])
        .filter((w) => w.enabled && (w.vrEnabled !== false))
        .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
    [currentDashboard?.widgets]
  );

  const atlasWidth = window.innerWidth;
  const padding = 4;

  // Shelf-packing: left-to-right, wrap to next row.
  const slots = useMemo<AtlasSlot[]>(() => {
    const result: AtlasSlot[] = [];
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const w of vrWidgets) {
      const ww = w.layout.width;
      const wh = w.layout.height;
      if (x + ww > atlasWidth && x > 0) {
        x = 0;
        y += rowH + padding;
        rowH = 0;
      }
      result.push({
        widgetId: w.id,
        x,
        y,
        width: ww,
        height: wh,
      });
      x += ww + padding;
      rowH = Math.max(rowH, wh);
    }
    return result;
  }, [vrWidgets, atlasWidth]);

  // Report the atlas layout to the main process.
  useEffect(() => {
    if (!window.vrAtlasBridge) return;
    const layers = slots.map((s) => ({
      widgetId: s.widgetId,
      sourceRect: [s.x, s.y, s.width, s.height] as [
        number,
        number,
        number,
        number,
      ],
    }));
    window.vrAtlasBridge.reportLayout(layers);
  }, [slots]);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {slots.map((slot, index) => {
        const widget = vrWidgets.find((w) => w.id === slot.widgetId);
        if (!widget) return null;
        const WidgetComponent = getWidget(widget.type || widget.id);
        if (!WidgetComponent) return null;
        const isSelected = editMode && selectedWidgetId === widget.id;
        return (
          <WidgetContainer
            key={widget.id}
            widget={{
              ...widget,
              layout: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
            }}
            editMode={false}
            zIndex={index + 1}
            onLayoutChange={noop}
          >
            {running || widget.alwaysEnabled ? (
              <ErrorBoundary
                label={`vr-widget:${widget.type || widget.id}`}
                resetAfterMs={2000}
              >
                <div className={isSelected ? 'outline outline-2 outline-green-500' : ''}>
                  <WidgetComponent {...widget.config} />
                </div>
              </ErrorBoundary>
            ) : null}
          </WidgetContainer>
        );
      })}
      {editMode && <VrEditInstructions />}
    </div>
  );
});
VrAtlasContainer.displayName = 'VrAtlasContainer';
