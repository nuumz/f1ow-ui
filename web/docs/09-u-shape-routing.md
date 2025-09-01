# U-Shape Routing Guide

This document explains all U-shape connection routing beha## Tunables & constants

### Centralized Configuration (v2.0)

All U-shape parameters are now centralized in `U_SHAPE_CONFIG`:

```typescript
const U_SHAPE_CONFIG = {
  // Proximity threshold for triggering U-shape routing
  PROXIMITY_THRESHOLD: 50, // FIXED_LEAD_LENGTH
  // Safe clearance around node boxes
  SAFE_CLEARANCE: 16,
  // Arrowhead trimming distance
  MARKER_TRIM: 5.5,
  // Buffer for obstacle detection
  OBSTACLE_BUFFER: 20,
} as const;
```

### Legacy Constants (for reference)

- `FIXED_LEAD_LENGTH` (default 50): Minimum straight segment used when computing the U's horizontal legs and proximity threshold.
- `safeClear`: unified to `16` across preview and final for all U-shape variants.
- `HALF_MARKER` (≈ 5.5): arrowhead outward trimming amount applied to final segments so arrowheads do not enter target nodes. implemented in the workflow designer, for both final (architecture mode) rendering and preview, including triggers, endpoints, and tunables. Use this as a reference for maintenance and future improvements.

## Recent Improvements (v2.0)

### ✅ Fixed Issues:

- **Proximity Detection Consistency**: Both preview and final modes now use the same logic (node.x vs centerX)
- **Left U-Shape Logic**: Added missing `dx > 0` check in final mode for consistency
- **Centralized Constants**: All U-shape parameters now use `U_SHAPE_CONFIG` for consistency
- **Basic Obstacle Awareness**: Added simple obstacle detection to prevent overlapping
- **Unit Tests**: Comprehensive test coverage for all U-shape variants

### 🎯 Key Improvements:

- Unified `U_SHAPE_CONFIG` with tunable parameters
- Consistent proximity thresholds (50px default)
- Standardized safe clearance (16px)
- Arrowhead trimming (5.5px)
- Basic obstacle detection with 20px buffer

## Where the logic lives

- File: `web/src/components/workflow-designer/utils/connection-utils.ts`
- Final (architecture mode): `generateArchitectureModeConnectionPath(...)`
- Preview: `calculateConnectionPreviewPath(...)`
- Dependencies/helpers:
  - `FIXED_LEAD_LENGTH` (from `path-generation.ts`) – default 50px
  - `buildNodeBox` / `buildNodeBoxModeAware`
  - `detectPortSideModeAware`, `getVirtualSidePortPositionForMode`
  - Fallback path generators: `generateAdaptiveOrthogonalRoundedPathSmart`, `generateConnectionPath`, `generatePreviewPath`

## Terminology

- "Same-side port": The target node port on the same side as the source’s starting side (e.g., start from right ⇒ end at target right port).
- `safeClear`: Horizontal clearance beyond the outer edge of node boxes to draw the U loop without overlapping node frames.

## Summary of U-shape variants

### 1) Bottom-to-Bottom U-shape (existing baseline)

- Applies when: A bottom→bottom connection would overlap or lacks vertical room, so a U path is drawn to avoid collision.
- Endpoint policy: Ends at target bottom port (same side by orientation: bottom).
- Clearance:
  - Final: `safeClear = 16`
  - Preview: `safeClear = 16` (unified)
- Notes: Maintains minimum vertical lead segments; used historically to avoid bottom-overlap artifacts.

### 1.5) Top U-shape — Start TOP ⇒ End TOP (v2.1)

- Trigger (final): When source is top port and target top edge is at preview end Y:
  - `sourcePortId === 'top' && previewEnd.y === hoverTargetBox.y`
- Trigger (preview): When source top port connects to target top edge
- Pathing strategy: Route around the outer top side using a midY above both nodes' topmost edges with `safeClear`.
- Endpoint policy: Force terminate at target top port (final) / top-edge center (preview) for symmetric behavior with Bottom U-Shape.
- Clearance:
  - Final: `safeClear = 16`
  - Preview: `safeClear = 16` (unified)
- Notes: Symmetric implementation to Bottom U-Shape, maintains minimum vertical lead segments upward.

### 2) Horizontal U-shape — Start RIGHT ⇒ End RIGHT (same-side)

- Trigger (final): Only when target is horizontally close:
  - `(targetNode.x - sourcePos.x) < FIXED_LEAD_LENGTH`
- Trigger (preview): CenterX-based proximity:
  - `(tgtCenterX - sourcePos.x) < FIXED_LEAD_LENGTH`
- Pathing strategy: Route around the outer right side using a midX beyond both nodes’ rightmost edges with `safeClear`.
- Endpoint policy: Force terminate at target right port (final) / right-edge center (preview) to avoid side flip.
- Clearance:
  - Final: `safeClear = 16`
  - Preview: `safeClear = 16` (unified)

### 3) Horizontal U-shape — Start LEFT ⇒ End LEFT (same-side)

- Trigger (final): Only when target is horizontally close:
  - `(sourcePos.x - targetNode.x) < FIXED_LEAD_LENGTH`
- Trigger (preview): CenterX-based proximity:
  - `(sourcePos.x - tgtCenterX) < FIXED_LEAD_LENGTH`
- Pathing strategy: Route around the outer left side using a midX beyond both nodes’ leftmost edges with `safeClear`.
- Endpoint policy: Force terminate at target left port (final) / left-edge center (preview) to avoid side flip.
- Clearance:
  - Final: `safeClear = 16`
  - Preview: `safeClear = 16` (unified)

## Fallback behavior

If none of the U-shape triggers match, the system uses the adaptive orthogonal router:

- Final (architecture mode): `generateAdaptiveOrthogonalRoundedPathSmart`
- Preview (architecture mode): `generateAdaptiveOrthogonalRoundedPathSmart`
- Preview (workflow mode): `generatePreviewPath`

## Rationale & design notes

- U-shapes are limited to “close horizontal” layouts to prevent accidental side-flips and to keep lines visually tidy.
- Preview mirrors final behavior to reduce surprise when dropping a connection.
- Same-side endpoint policy ensures the arrow head consistently lands where users expect during short horizontal drags.

## Tunables & constants

- `FIXED_LEAD_LENGTH` (default 50): Minimum straight segment used when computing the U’s horizontal legs and proximity threshold.
- `safeClear`: unified to `16` across preview and final for all U-shape variants.
- `HALF_MARKER` (≈ 5.5): arrowhead outward trimming amount applied to final segments so arrowheads do not enter target nodes.

### Arrowhead trimming (new)

- Both preview and final trim the endpoint “outward” from the node by ~5.5px depending on the chosen side:
  - Left: x + 5.5, Right: x - 5.5, Top: y + 5.5, Bottom: y - 5.5.
- Bottom U-shape: trim is applied on the final upward segment so the arrowhead stays clear of the node frame.

## Known inconsistencies / improvement backlog

### ✅ Recently Fixed:

1. ~~Proximity detection inconsistency~~ → Fixed: Both modes use same node.x logic
2. ~~Left U-shape missing dx > 0 check~~ → Fixed: Added consistent direction check
3. ~~Scattered constants~~ → Fixed: Centralized in `U_SHAPE_CONFIG`
4. ~~No tests~~ → Fixed: Added comprehensive unit tests

### 🔄 Future Improvements:

1. **Advanced Obstacle Awareness**: Account for intermediate nodes/labels when choosing midX; consider occupancy grid
2. **Dynamic Configurability**: Expose `U_SHAPE_CONFIG` via theme/config for per-tenant tuning
3. **Path Optimization**: Adaptive clearance based on available space
4. **Preview Smoothing**: Ensure exact parity of rounding radius in all edge layouts

## Quick reference (pseudo-conditions)

- Start RIGHT → Same-side U:
  - Final: if `(target.x - source.x) < FIXED_LEAD_LENGTH` ⇒ route right-outer, end at target RIGHT.
  - Preview: if `(tgtCenterX - source.x) < FIXED_LEAD_LENGTH` ⇒ route right-outer, end at right-edge center.
- Start LEFT → Same-side U:
  - Final: if `(source.x - target.x) < FIXED_LEAD_LENGTH` ⇒ route left-outer, end at target LEFT.
  - Preview: if `(source.x - tgtCenterX) < FIXED_LEAD_LENGTH` ⇒ route left-outer, end at left-edge center.
- Bottom-to-Bottom U:
  - Apply when bottom overlap/clearance issues are detected; end at bottom; higher preview `safeClear`.

## Edit pointers

- Horizontal U (final): search for `startSide === 'right'` / `startSide === 'left'` U-shape blocks in `generateArchitectureModeConnectionPath`.
- Horizontal U (preview): search for `startSidePrev === 'right'` / `startSidePrev === 'left'` in `calculateConnectionPreviewPath`.
- Bottom U: dedicated block within both functions; look for comments mentioning bottom U-shape or vertical clearance.

## Compatibility

- Changes preserve existing APIs. Only routing heuristics are adjusted. Non-U cases continue to use the adaptive orthogonal router.
