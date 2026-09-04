import { memo, useEffect, useMemo, useState } from 'react';
import { useDashboard, useRunningState } from '@irdashies/context';
import { getWidget } from '../../WidgetIndex';
import { WidgetContainer } from '../WidgetContainer';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';
import { VrEditInstructions } from './VrEditInstructions';
import { PitLapUpdater } from '../OverlayContainer/PitLapUpdater';
import { PushToPassUpdater } from '../OverlayContainer/PushToPassUpdater';
import { SessionTimingUpdater } from '../OverlayContainer/SessionTimingUpdater';
import { SectorTimingUpdater } from '../OverlayContainer/SectorTimingUpdater';

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
  const init = window.__vrEdit;
  const [livePos, setLivePos] = useState<{ x: number; y: number }>({
    x: init?.x ?? 0,
    y: init?.y ?? 0,
  });
  const [livePosCache, setLivePosCache] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        active: boolean;
        id: string;
        x: number;
        y: number;
      };
      setEditMode(d.active);
      setSelectedWidgetId(d.id || null);
      const pos = { x: d.x ?? 0, y: d.y ?? 0 };
      setLivePos(pos);
      // Cache the live position for this widget so it persists after deselection.
      if (d.id)
        setLivePosCache((prev) => {
          const next = new Map(prev);
          next.set(d.id, pos);
          return next;
        });
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
        .filter((w) => w.enabled && w.vrEnabled !== false)
        .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
    [currentDashboard?.widgets]
  );

  const atlasWidth = window.innerWidth;
  const MARGIN_X = 200;

  // Shelf-packing with left margin so widgets aren't pinned to the edge.
  const slots = useMemo<AtlasSlot[]>(() => {
    const result: AtlasSlot[] = [];
    const padding = 4;
    let fallbackX = MARGIN_X;
    let fallbackY = MARGIN_X;
    let rowH = 0;

    for (const w of vrWidgets) {
      const ww = w.layout.width;
      const wh = w.layout.height;
      // During edit mode, use live position for the selected widget.
      const isSelected = editMode && w.id === selectedWidgetId;
      if (isSelected) {
        result.push({
          widgetId: w.id,
          x: livePos.x,
          y: livePos.y,
          width: ww,
          height: wh,
        });
        continue;
      }
      // Check the live cache first (positions from this edit session).
      const cached = livePosCache.get(w.id);
      if (cached) {
        result.push({
          widgetId: w.id,
          x: cached.x,
          y: cached.y,
          width: ww,
          height: wh,
        });
        continue;
      }
      // Use saved position if available; otherwise auto-pack with margin.
      if (w.vrAtlasX != null && w.vrAtlasY != null) {
        result.push({
          widgetId: w.id,
          x: w.vrAtlasX,
          y: w.vrAtlasY,
          width: ww,
          height: wh,
        });
      } else {
        // Auto-pack fallback.
        if (fallbackX + ww > atlasWidth - MARGIN_X && fallbackX > MARGIN_X) {
          fallbackX = MARGIN_X;
          fallbackY += rowH + padding;
          rowH = 0;
        }
        result.push({
          widgetId: w.id,
          x: fallbackX,
          y: fallbackY,
          width: ww,
          height: wh,
        });
        fallbackX += ww + padding;
        rowH = Math.max(rowH, wh);
      }
    }
    return result;
  }, [
    vrWidgets,
    livePos,
    editMode,
    selectedWidgetId,
    atlasWidth,
    livePosCache,
  ]);

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
      <PitLapUpdater />
      <PushToPassUpdater />
      <SessionTimingUpdater />
      <SectorTimingUpdater />
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
              layout: {
                x: slot.x,
                y: slot.y,
                width: slot.width,
                height: slot.height,
              },
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
                <div
                  className={
                    isSelected ? 'outline outline-2 outline-green-500' : ''
                  }
                >
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
