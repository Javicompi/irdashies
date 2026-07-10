import { memo, useEffect, useMemo } from 'react';
import { useDashboard, useRunningState } from '@irdashies/context';
import { getWidget } from '../../WidgetIndex';
import { WidgetContainer } from '../WidgetContainer';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';

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

  // All enabled widgets; vrEnabled defaults to true (matches pre-P2 behaviour).
  const vrWidgets = useMemo(
    () =>
      currentDashboard?.widgets.filter(
        (w) => w.enabled && (w.vrEnabled !== false)
      ) ?? [],
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
        return (
          <WidgetContainer
            key={widget.id}
            widget={{
              ...widget,
              layout: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
            }}
            editMode={false}
            zIndex={index + 1}
          >
            {running || widget.alwaysEnabled ? (
              <ErrorBoundary
                label={`vr-widget:${widget.type || widget.id}`}
                resetAfterMs={2000}
              >
                <WidgetComponent {...widget.config} />
              </ErrorBoundary>
            ) : null}
          </WidgetContainer>
        );
      })}
    </div>
  );
});
VrAtlasContainer.displayName = 'VrAtlasContainer';
