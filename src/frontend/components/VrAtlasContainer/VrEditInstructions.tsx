import { memo, useState, useEffect } from 'react';

export const VrEditInstructions = memo(() => {
  const [position, setPosition] = useState<[number, number, number]>([0, 0, -1.5]);

  useEffect(() => {
    if (!window.vrEditBridge) return;
    const unmove = window.vrEditBridge.onMove((pos) => setPosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]));
    const unsel = window.vrEditBridge.onSelect((_, pos) => setPosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]));
    const unmode = window.vrEditBridge.onEditMode((_, __, pos) => setPosition([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -1.5]));
    return () => { unmove(); unsel(); unmode(); };
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
          <span className="text-white/75">Adjust position X / Y</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Q / E</span>
          <span className="text-white/75">Adjust distance Z</span>
        </div>
      </div>
      <div className="flex items-baseline justify-between text-sm pt-3 border-t border-slate-600/20">
        <span className="font-bold text-slate-300">Position</span>
        <div className="flex gap-6">
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">X: {fmt(position[0])}</span>
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">Y: {fmt(position[1])}</span>
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">Z: {fmt(position[2])}</span>
        </div>
      </div>
    </div>
  );
});
VrEditInstructions.displayName = 'VrEditInstructions';
