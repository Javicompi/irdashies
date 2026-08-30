# Fuel Calculator: Channel Architecture Migration Context

> **Status:** Decision record — August 2026 (post upstream merge `0d421c65`)
> **Purpose:** Context for a future migration of the fuel calculator from the
> renderer-side (raw telemetry) architecture to the channel/processor
> architecture. Read this before touching `setProjectionLaps` or planning fuel
> work in the main process.

---

## 1. Why this document exists

The 2026-08 upstream merge brought `FuelProjectionProcessor` (upstream's
main-process fuel projection) and its renderer counterpart
`useFuelProjectionSnapshot`. The fork deliberately kept its own renderer-side
fuel implementation. This document records what was kept, why, and what a
future channel migration would involve — so the decision does not get re-lit
from scratch.

## 2. Current (fork) architecture — renderer-side calculation

```
iRacing (60 Hz)
   ↓
[Main] iracingSdkBridge → publishMessage('telemetry', ...)  (subscription-gated)
   ↓
[Renderer] TelemetryProvider → TelemetryStore (Zustand)
   ↓
useFuelCalculation (hook, ~1600 lines) — the fork's full fuel logic:
   - lap recording: IQR outlier rejection, 15% tolerance, tow exclusion,
     green-flag-only laps, refuel detection, in/out lap marking
   - projection: smoothed live usage, progressive confidence, leader vs
     player pace (timed multi-class), checkered-flag projection, wall-clock
     fallback
   - persistence: fuelDatabase (SQLite) per track+car, qualify consumption
   ↓
FuelStore (Zustand) → widgets (LAPS | STINTS | REFUEL grid, fuelLaps, ...)
```

Raw telemetry reaches the renderer through the fork-restored `telemetry`
stream (`IrSdkRawTelemetryBridge`), gated per window by the renderer-data
subscription registry — only subscribed windows receive it.

## 3. Target architecture — channels (ARCHITECTURE_RULES R4.4–R4.6, R5.1–R5.3)

```
iRacing (60 Hz)
   ↓
[Main] FuelProjectionProcessor (TelemetryProcessor, tickRateHz = 5)
   onFrame(telemetry) → snapshot (minimal payload)
   ↓
ChannelBus → per-window subscriptions (closed/hidden windows get nothing)
   ↓
[Renderer] useFuelProjectionSnapshot() → widgets
```

Benefits per the architecture review: deterministic processors tested with
recorded fixtures (R5.2), no per-frame renderer wake-ups, no duplicated
calculation, per-window delivery (R4.6).

## 4. What upstream shipped (and why it was NOT adopted in the merge)

Upstream's `FuelProjectionProcessor` (`src/app/processors/FuelProjectionProcessor.ts`)
hosts a `FuelProjectionEngine` — a **simpler subset** of the fork's logic:

| Fork (renderer)                      | Upstream engine (main)      |
| ------------------------------------ | --------------------------- |
| IQR outliers + 15% tolerance         | basic `validateLap`         |
| tow exclusion, green-flag-only laps  | green flag, no tow handling |
| refuel detection, in/out lap marking | basic                       |
| DB persistence (track+car) + qualify | opt-in persistence, no DB   |

Adopting upstream's processor would mean **replacing the fork's validated
recording with a simpler one** — a downgrade, so the merge kept the fork's
implementation. Upstream's processor remains wired for its own consumers
(`SessionTimingProcessor`, its Gantry, etc.) but does not feed the fork's
fuel widgets.

## 5. `setProjectionLaps` — added by upstream, removed by the fork

Upstream's renderer used it to mirror the processor's recorded laps into the
store:

```ts
// upstream's useFuelCalculation (replaced in the merge):
state.setProjectionLaps(projection.completedLaps);
```

In the merged tree nothing consumes `projection.completedLaps` — the fuel
projection snapshot is only read for `sessionType`, `isOnTrack` and
`fuelLevel` (FuelCalculator shell, FuelCalculatorTargetMessage,
FuelCalculatorPitScenarios). The action was dead code and was **removed on
2026-08-30** (commit after the upstream merge). `isHistorical` handling in
`setLapHistory` (fork) is unrelated and stays.

## 6. If a future channel migration happens

1. Port the fork's fuel logic (IQR, projection smoothing, leader/player pace,
   STINTS, fuelLaps leaderRaceLaps) into a `TelemetryProcessor` class in
   `src/app/processors/`, with recorded-fixture specs (R5.2).
2. Decide how `useTotalRaceValue` (already a superset of upstream's
   `SessionTimingSnapshot` fields, plus `leaderRaceLaps`) relates to the
   `SessionTimingProcessor`.
3. Re-add a store action to mirror processor laps (declaration + ~20 lines +
   one call site) — the removed `setProjectionLaps` is the reference shape:
   merge incoming laps with `isHistorical` DB laps, invalidate the sorted
   cache, update `_oldestLapNumber`.
4. Keep `useFuelProjectionSnapshot` consumers in mind: the shell's
   visibility/`isOnTrack`/`fuelLevel` already read the snapshot; the
   calculator itself does not.
5. Verify in a real session before merging — timed multi-class races are the
   fork's regression surface (see `useTotalRaceValue.spec.tsx` scenarios).
