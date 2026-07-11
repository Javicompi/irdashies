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
  const [livePos, setLivePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { active: boolean; id: string; x: number; y: number };
      setEditMode(d.active);
      setSelectedWidgetId(d.id || null);
      setLivePos({ x: d.x ?? 0, y: d.y ?? 0 });
    };
    window.addEventListener('vr-edit-state', handler);
    return () => window.removeEventListener('vr-edit-state', handler);
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
    let fallbackX = 0;
    let fallbackY = 0;
    let rowH = 0;
    const padding = 4;
    const atlasWidth = window.innerWidth;

    for (const w of vrWidgets) {
      const ww = w.layout.width;
      const wh = w.layout.height;
      // During edit mode, use live position for the selected widget.
      const isSelected = editMode && w.id === selectedWidgetId;
      if (isSelected) {
        result.push({ widgetId: w.id, x: livePos.x, y: livePos.y, width: ww, height: wh });
        continue;
      }
      if (w.vrAtlasX != null && w.vrAtlasY != null) {
        // User-placed: use saved position.
        result.push({ widgetId: w.id, x: w.vrAtlasX, y: w.vrAtlasY, width: ww, height: wh });
      } else {
        // Auto-pack fallback (first run, before edit mode).
        if (fallbackX + ww > atlasWidth && fallbackX > 0) {
          fallbackX = 0;
          fallbackY += rowH + padding;
          rowH = 0;
        }
        result.push({ widgetId: w.id, x: fallbackX, y: fallbackY, width: ww, height: wh });
        fallbackX += ww + padding;
        rowH = Math.max(rowH, wh);
      }
    }
    return result;
  }, [vrWidgets, livePos, editMode, selectedWidgetId]);

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
