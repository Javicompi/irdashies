import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
  const init = (window as any).__vrEdit as { x?: number; y?: number } | undefined;
  const [livePos, setLivePos] = useState<{ x: number; y: number }>({ x: init?.x ?? 0, y: init?.y ?? 0 });
  const livePosCache = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { active: boolean; id: string; x: number; y: number };
      setEditMode(d.active);
      setSelectedWidgetId(d.id || null);
      const pos = { x: d.x ?? 0, y: d.y ?? 0 };
      setLivePos(pos);
      // Cache the live position for this widget so it persists after deselection.
      if (d.id) livePosCache.current.set(d.id, pos);
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
    const padding = 4;
    const atlasWidth = window.innerWidth;

    // Compute the total width needed for auto-packed widgets to centre them.
    let packedW = 0;
    let packedCount = 0;
    for (const w of vrWidgets) {
      if (livePosCache.current.has(w.id)) continue;
      packedW += w.layout.width + (packedCount > 0 ? padding : 0);
      packedCount++;
    }
    const startX = Math.max(0, Math.round((atlasWidth - packedW) / 2));
    let fallbackX = startX;
    let fallbackY = 0;
    let rowH = 0;

    for (const w of vrWidgets) {
      const ww = w.layout.width;
      const wh = w.layout.height;
      // During edit mode, use live position for the selected widget.
      const isSelected = editMode && w.id === selectedWidgetId;
      if (isSelected) {
        result.push({ widgetId: w.id, x: livePos.x, y: livePos.y, width: ww, height: wh });
        continue;
      }
      // Check the live cache first (positions from this edit session).
      const cached = livePosCache.current.get(w.id);
      if (cached) {
        result.push({ widgetId: w.id, x: cached.x, y: cached.y, width: ww, height: wh });
        continue;
      }
      // Auto-pack fallback for all non-cached widgets (centered).
      if (fallbackX + ww > atlasWidth && fallbackX > startX) {
        fallbackX = startX;
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
