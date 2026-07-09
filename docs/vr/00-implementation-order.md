# irDashies VR — Implementation order for the 7 optimization changes

This schedules the seven changes in `docs/vr/01..07`. Each entry lists **why
this order**: dependencies between changes, what unblocks what, and where the
risk is.

The changes themselves are documented in detail in their own files. This doc is
only the sequencing rationale.

## Dependency map

```
#03 (iRacing gate)        ── independent, consumer-only
#02 (format match)        ── independent, ~consumer-only
#01 (triple-buffer ring)  ── SHM contract bump to v2 ──┬──> #04 (atlas + N quads)
                                                        └──> #07 (skip redundant work)
#04 (atlas + N quads)     ──> #05 (maxLayerCount + vector reuse)
#06 (device robustness)   ── independent; slot anywhere (recommended last)
```

Key constraint: **#01 bumps the SHM contract to v2**. Design the v2 header in
#01 so it **already reserves** the per-layer table that #04 will fill, so #04
is additive and does **not** force a third SHM version bump. Read
`docs/vr/01-triple-buffer-ring.md` and `docs/vr/04-atlas-multi-quad.md` together
before writing the v2 header.

## Recommended order

### Phase 0 — Safety shield (do first, independent)

**1. `#03` iRacing process gate** → `docs/vr/03-iracing-process-gate.md`

- Why first: trivial, consumer-only, no dependencies. Protects every **other**
  VR title on the machine from being injected while you iterate on the rest.
  The design doc calls this the "main risk mitigation" — ship it before any
  experimental build gets registered.
- Cost: very low (one process-name check + early returns).
- Unblocks: safe iteration on everything else.

**2. `#02` format match / channel swizzle** → `docs/vr/02-format-match-swizzle.md`

- Why now: correctness (R/B swap), low cost, nearly consumer-only, independent
  of the ring. Validate it on the **current single-quad pipeline** first — if
  you leave it for later you'll be chasing colour bugs while debugging harder
  things. The headless `shm-probe` pixel test confirms it fast.
- Cost: low.
- Unblocks: trustworthy colours for all subsequent in-headset validation.

### Phase 1 — SHM contract foundation

**3. `#01` triple-buffer ring** → `docs/vr/01-triple-buffer-ring.md`

- Why now: the highest-severity correctness bug (tearing under iRacing GPU
  load) **and** the foundation for #04 and #07. This is the SHM v2 bump — the
  point of no return for the shared contract. Do it before the architecture
  change so #04/#07 don't force a second contract revision.
- Cost: medium (touches producer addon, consumer, test producer, probe, and
  the shared header).
- Unblocks: #04, #07.
- **Design the v2 header with the `IrdashiesShmLayer[]` table reserved** even
  if #01 doesn't populate it, so #04 is additive.

### Phase 2 — Target architecture

**4. `#04` atlas + N per-widget quads** → `docs/vr/04-atlas-multi-quad.md`

- Why now: depends on #01 (ring + reserved layer table). This is the change
  that answers the reviewer comment ("render all overlays in one page/one
  consumer, pack to one atlas, split into per-widget quads with sub-rects").
  Do it right after the ring so the `xrEndFrame` layer loop is only rewritten
  once (here), not twice.
- Cost: high (new VR atlas page in the renderer, layer table plumbing, the
  consumer N-quad loop). The biggest item.
- Unblocks: #05 (the N quads it emits are what #05 caps/reuses).

**5. `#05` maxLayerCount + vector reuse** → `docs/vr/05-maxlayercount-vector-reuse.md`

- Why now: natural pair with #04 — the N quads it caps come from #04, and the
  reused vector is easiest to wire while the layer-loop code from #04 is fresh.
  Doing #05 before #04 would be nearly trivial (one quad) and you'd redo it.
- Cost: low-medium.
- Unblocks: nothing, but hardens #04.

### Phase 3 — Performance polish

**6. `#07` skip redundant per-frame work** → `docs/vr/07-skip-redundant-frame-work.md`

- Why now: depends on the per-slot `SlotView` cache introduced by #01. Do it
  after #04/#05 so the new-content classification isn't rewired when the layer
  loop changes. Consumer-only.
- Cost: low.
- Savings: removes the cross-process handle check + fence wait on frames with
  no new producer content (about half the frames at 60 Hz producer / 120 Hz
  game). The blit is **kept** (OpenXR swapchain correctness requires it).

### Phase 4 — Robustness (deferred)

**7. `#06` layer device/context robustness** → `docs/vr/06-dedicated-device-robustness.md`

- Why last: already mitigated today (the blit runs on a **deferred** context
  with `ExecuteCommandList(..., TRUE)` = `RestoreContextState`, so the game's
  pipeline state is restored). What remains is `SetMultithreadProtected(TRUE)`,
  routing the fallback clear through the deferred context, and optionally
  failing session setup if `CreateDeferredContext` fails. Low ROI; not on the
  critical path.
- Cost: very low.
- Note: the doc also explains why a **dedicated** layer device is **not**
  recommended for the current workload (swapchain images live on the game
  device, so a separate device would force a second blit + shared texture for
  no benefit). Read it before considering that path.

## Quick reference: cost / risk / dependency

| #  | Change                    | Phase | Cost     | Depends on | Unblocks |
| -- | ------------------------- | ----- | -------- | ---------- | -------- |
| 03 | iRacing gate              | 0     | very low | —          | safe iteration |
| 02 | format match / swizzle    | 0     | low      | —          | correct colours |
| 01 | triple-buffer ring        | 1     | medium   | —          | #04, #07 |
| 04 | atlas + N quads           | 2     | high     | #01        | #05 |
| 05 | maxLayerCount + reuse     | 2     | low-med  | #04        | — |
| 07 | skip redundant work       | 3     | low      | #01        | — |
| 06 | device robustness         | 4     | very low | —          | — |

## One-line summary

Gate first (so you can't break other games), fix colours (so you can trust
what you see), build the ring (the correctness foundation + SHM v2), then the
atlas + N quads (the architecture the reviewer asked for), cap and reuse the
layers, skip redundant work, and finish with device-context hardening that's
already mostly done.
