import { memo, useState, useEffect } from 'react';

export const VrEditInstructions = memo(() => {
  const init = (window as any).__vrEdit as { x?: number; y?: number; z?: number } | undefined;
  const [pos, setPos] = useState({ x: init?.x ?? 0, y: init?.y ?? 0, z: init?.z ?? -1.5 });

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { x: number; y: number; z: number };
      setPos({ x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? -1.5 });
    };
    window.addEventListener('vr-edit-state', handler);
    return () => window.removeEventListener('vr-edit-state', handler);
  }, []);

  const fmt = (n: number) => n.toFixed(2);

  return (
    <div
      className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999]
                 bg-slate-900/95 border border-slate-600/25 rounded
                 px-8 py-5 text-white font-sans pointer-events-none"
      style={{ minWidth: '440px' }}
    >
      <div className="flex flex-col gap-2 mb-3">
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Ctrl+Shift+F9</span>
          <span className="text-white/75">Exit edit mode</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Space</span>
          <span className="text-white/75">Cycle overlay</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Arrow keys</span>
          <span className="text-white/75">Move overlay (X / Y)</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Q / E</span>
          <span className="text-white/75">Distance -- all overlays (Z)</span>
        </div>
      </div>
      <div className="flex items-baseline justify-between text-sm pt-3 border-t border-slate-600/20">
        <span className="font-bold text-slate-300">Position</span>
        <div className="flex gap-6">
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            X: {pos.x.toFixed(0)}px
          </span>
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            Y: {pos.y.toFixed(0)}px
          </span>
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            Z: {pos.z.toFixed(2)}m
          </span>
        </div>
      </div>
    </div>
  );
});
VrEditInstructions.displayName = 'VrEditInstructions';
