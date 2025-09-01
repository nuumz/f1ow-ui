import { useCallback, useMemo, useRef, useEffect } from 'react';
import type { Connection, NodeVariant, WorkflowNode } from '../types';
import { generateModeAwareConnectionPath, generateArchitectureModeConnectionPathWithTargetSide, getModeAwarePortAnchors } from '../utils/connection-utils';
import { PERFORMANCE_CONSTANTS } from '../utils/canvas-constants';

type DragPos = { x: number; y: number };
type SidePortId = '__side-left' | '__side-right' | '__side-top' | '__side-bottom'

// Connection endpoint tracking for smooth interpolation
interface ConnectionEndpoint {
  x: number;
  y: number;
  lastUpdate: number;
}

interface ConnectionEndpoints {
  source: ConnectionEndpoint;
  target: ConnectionEndpoint;
}

export interface UseConnectionPathsApi {
  getConnectionPath: (connection: Connection, useDragPositions?: boolean) => string;
  updateDragPosition: (nodeId: string, pos: DragPos) => void;
  clearAllDragPositions: () => void;
  clearCache: () => void;
  // New: Get current endpoint positions for a connection
  getConnectionEndpoints: (connection: Connection) => ConnectionEndpoints | null;
}

/**
 * useConnectionPaths
 * Centralizes path generation with lightweight caching and drag overrides.
 * - Workflow mode: bezier-like paths
 * - Architecture mode: orthogonal rounded paths
 */
export function useConnectionPaths(
  nodes: WorkflowNode[],
  nodeVariant: NodeVariant,
  modeId: 'workflow' | 'architecture' | undefined,
  isAnyDragging: boolean = false
): UseConnectionPathsApi {
  const pathCacheRef = useRef<Map<string, string>>(new Map());
  const dragPositionsRef = useRef<Map<string, DragPos>>(new Map());
  // Sticky target side per-connection to avoid one-frame jumps in architecture mode
  const stickySideRef = useRef<Map<string, { side: SidePortId; ts: number }>>(new Map());

  const nodeMap = useMemo(() => {
    const m = new Map<string, WorkflowNode>();
    nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [nodes]);

  const clearCache = useCallback(() => {
    pathCacheRef.current.clear();
  }, []);

  // Important: Invalidate cached paths whenever node list/positions, variant, or mode changes
  // This prevents stale paths (e.g., from a previous drag) from being reused and causing flicker
  useEffect(() => {
    pathCacheRef.current.clear();
  }, [nodes, nodeVariant, modeId]);

  // Reset sticky side selection when changing mode to prevent stale overrides across modes
  useEffect(() => {
    stickySideRef.current.clear();
  }, [modeId]);

  // Current endpoint positions storage (ref-based to avoid re-renders during drag)
  const endpointPositionsRef = useRef<Map<string, ConnectionEndpoints>>(new Map());

  // Get connection ID for endpoint tracking
  const getConnectionId = (connection: Connection): string =>
    `${connection.sourceNodeId}:${connection.sourcePortId || 'right'}->${connection.targetNodeId}:${connection.targetPortId || 'left'}`;

  // Get current endpoint positions for a connection
  const getConnectionEndpoints = useCallback((connection: Connection): ConnectionEndpoints | null => {
    const connectionId = getConnectionId(connection);
    return endpointPositionsRef.current.get(connectionId) || null;
  }, []);

  // Update endpoint positions with smooth interpolation
  const updateEndpointPositions = useCallback((connection: Connection, newEndpoints: ConnectionEndpoints) => {
    const connectionId = getConnectionId(connection);
    const map = endpointPositionsRef.current;
    const existing = map.get(connectionId);

    if (!existing) {
      map.set(connectionId, {
        source: { ...newEndpoints.source, lastUpdate: Date.now() },
        target: { ...newEndpoints.target, lastUpdate: Date.now() }
      });
    } else {
      // Smooth interpolation for existing endpoints without triggering React renders
      const now = Date.now();
      const timeDelta = Math.min(now - (existing.source.lastUpdate || 0), 16); // Max 16ms for 60fps
      const lerpFactor = Math.min(timeDelta / 100, 1); // 100ms to full position

      map.set(connectionId, {
        source: {
          x: existing.source.x + (newEndpoints.source.x - existing.source.x) * lerpFactor,
          y: existing.source.y + (newEndpoints.source.y - existing.source.y) * lerpFactor,
          lastUpdate: now
        },
        target: {
          x: existing.target.x + (newEndpoints.target.x - existing.target.x) * lerpFactor,
          y: existing.target.y + (newEndpoints.target.y - existing.target.y) * lerpFactor,
          lastUpdate: now
        }
      });
    }
  }, []);

  // Clear endpoint positions when mode changes (ref-based)
  useEffect(() => {
    endpointPositionsRef.current.clear();
  }, [modeId]);

  const updateDragPosition = useCallback((nodeId: string, pos: DragPos) => {
    dragPositionsRef.current.set(nodeId, pos);
  }, []);


  const clearAllDragPositions = useCallback(() => {
    dragPositionsRef.current.clear();
    // Also clear cache to force immediate regeneration with committed positions
    pathCacheRef.current.clear();
    // Reset sticky sides so routing can re-evaluate after drag
    stickySideRef.current.clear();
  }, []);

  const cleanupCacheIfNeeded = useCallback(() => {
    const cache = pathCacheRef.current;
    const size = cache.size;
    const MAX_CACHE_SIZE = PERFORMANCE_CONSTANTS.MAX_CACHE_SIZE;
    const CACHE_CLEANUP_THRESHOLD = PERFORMANCE_CONSTANTS.CACHE_CLEANUP_THRESHOLD;
    if (size <= MAX_CACHE_SIZE) {
      return;
    }

    // Probabilistic pruning
    const overBy = size - MAX_CACHE_SIZE;
    const pressureRatio = Math.min(1, overBy / (MAX_CACHE_SIZE * 0.5));
    const baseSample = 0.02 + pressureRatio * 0.08; // 2%-10%
    const softTarget = Math.floor(MAX_CACHE_SIZE * 0.95);
    let removed = 0;
    for (const key of cache.keys()) {
      if (cache.size <= softTarget) {
        break;
      }
      if (Math.random() < baseSample) {
        cache.delete(key);
        removed++;
      }
    }
    if (cache.size > CACHE_CLEANUP_THRESHOLD) {
      const toRemove = cache.size - CACHE_CLEANUP_THRESHOLD;
      let i = 0;
      for (const key of cache.keys()) {
        cache.delete(key);
        i++;
        if (i >= toRemove) {
          break;
        }
      }
    }
    if (removed > 0 && process.env.NODE_ENV === 'development') {
      console.warn('[useConnectionPaths] cache pruned by', removed);
    }
  }, []);

  // Helper: build cache key (avoid nested template literals)
  const buildCacheKey = useCallback((
    connection: Connection,
    variant: NodeVariant,
    mode: string | undefined,
    posSig?: string
  ) => {
    const parts = [
      connection.id,
      connection.sourceNodeId,
      connection.sourcePortId,
      connection.targetNodeId,
      connection.targetPortId,
      String(variant),
      mode || 'workflow',
    ] as Array<string>
    if (mode === 'architecture') {
      const side = stickySideRef.current.get(connection.id)?.side || 'none'
      parts.push(`side:${side}`)
    }
    if (posSig) {
      parts.push(`pos:${posSig}`)
    }
    return parts.join('|')
  }, [])

  // Helper: decide sticky side with hysteresis (no nested ternary)
  const decideStickySide = useCallback((
    connectionId: string,
    source: WorkflowNode,
    target: WorkflowNode
  ): SidePortId => {
    const dx = target.x - source.x
    const dy = target.y - source.y
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    const HYSTERESIS_MARGIN = 14

    let autoSide: '__side-left' | '__side-right' | '__side-top' | '__side-bottom'
    if (absDx - absDy > HYSTERESIS_MARGIN) {
      autoSide = dx > 0 ? '__side-left' : '__side-right'
    } else if (absDy - absDx > HYSTERESIS_MARGIN) {
      autoSide = dy > 0 ? '__side-top' : '__side-bottom'
    } else {
      const prev = stickySideRef.current.get(connectionId)?.side
      if (prev) {
        autoSide = prev
      } else if (absDx >= absDy) {
        autoSide = dx > 0 ? '__side-left' : '__side-right'
      } else {
        autoSide = dy > 0 ? '__side-top' : '__side-bottom'
      }
    }

    const prev = stickySideRef.current.get(connectionId)?.side
    if (!prev || prev === autoSide) {
      return autoSide
    }
    const SWITCH_MARGIN = 24
    const dominance = Math.abs(absDx - absDy)
    const dominantAxisIsX = absDx >= absDy
    if (dominantAxisIsX && dominance < SWITCH_MARGIN) {
      return prev
    }
    if (!dominantAxisIsX && dominance < SWITCH_MARGIN) {
      return prev
    }
    return autoSide
  }, [])

  const getConnectionPath = useCallback(
    (connection: Connection, useDragPositions = false): string => {
      // CRITICAL FIX: Take atomic snapshot of current state to prevent race conditions
      const dragSnapshot = new Map(dragPositionsRef.current);
      const anyDragActive = isAnyDragging || dragSnapshot.size > 0;
      const effectiveUseDrag = useDragPositions || anyDragActive;

      const sourceNode = nodeMap.get(connection.sourceNodeId);
      const targetNode = nodeMap.get(connection.targetNodeId);
      if (!sourceNode || !targetNode) {
        return '';
      }

      // ENHANCED: Build position-consistent nodes array with atomic snapshot
      let nodesForPath: WorkflowNode[] = nodes;
      if (effectiveUseDrag) {
        // Use atomic snapshot to prevent race conditions between source/target position updates
        const srcDrag = dragSnapshot.get(connection.sourceNodeId);
        const tgtDrag = dragSnapshot.get(connection.targetNodeId);

        // Only create modified array if we actually have drag positions to apply
        if (srcDrag || tgtDrag) {
          nodesForPath = nodes.map((n) => {
            // Apply drag position if available for this specific node
            if (srcDrag && n.id === connection.sourceNodeId) {
              return { ...n, x: srcDrag.x, y: srcDrag.y };
            }
            if (tgtDrag && n.id === connection.targetNodeId) {
              return { ...n, x: tgtDrag.x, y: tgtDrag.y };
            }
            // Use committed position for all other nodes
            return n;
          });
        }
      }

      // Architecture mode: decide sticky-side BEFORE building cache key to avoid stale reuse
      let path: string;
      let cacheKey: string | null = null;
      let posSig: string = 'na';
      if ((modeId || 'workflow') === 'architecture') {
        const s = nodesForPath.find(n => n.id === connection.sourceNodeId);
        const t = nodesForPath.find(n => n.id === connection.targetNodeId);
        if (!s || !t) { return '' }
        const useSide = decideStickySide(connection.id, s, t)
        stickySideRef.current.set(connection.id, { side: useSide, ts: performance.now() });

        // Build posSig from committed positions (not drag) to invalidate when nodes move
        const srcForKey = nodes.find(n => n.id === connection.sourceNodeId);
        const tgtForKey = nodes.find(n => n.id === connection.targetNodeId);
        const fmt = (v: number) => v.toFixed(2);
        posSig = srcForKey && tgtForKey
          ? `${fmt(srcForKey.x)},${fmt(srcForKey.y)}->${fmt(tgtForKey.x)},${fmt(tgtForKey.y)}`
          : 'na';
        cacheKey = buildCacheKey(connection, nodeVariant, modeId, posSig);

        if (!effectiveUseDrag && !anyDragActive) {
          const cached = pathCacheRef.current.get(cacheKey);
          if (cached) {
            return cached;
          }
        }

        path = generateArchitectureModeConnectionPathWithTargetSide(
          s,
          t,
          {
            sourceNodeId: connection.sourceNodeId,
            sourcePortId: connection.sourcePortId,
            targetNodeId: connection.targetNodeId,
            targetPortId: connection.targetPortId,
          },
          useSide
        );
      } else {
        // Precompute committed positions for cache key (avoid reuse after node moves without array identity change)
        const srcForKey = nodes.find(n => n.id === connection.sourceNodeId);
        const tgtForKey = nodes.find(n => n.id === connection.targetNodeId);
        const fmt = (v: number) => v.toFixed(2);
        posSig = srcForKey && tgtForKey
          ? `${fmt(srcForKey.x)},${fmt(srcForKey.y)}->${fmt(tgtForKey.x)},${fmt(tgtForKey.y)}`
          : 'na';
        cacheKey = buildCacheKey(connection, nodeVariant, modeId, posSig);

        if (!effectiveUseDrag && !anyDragActive) {
          const cached = pathCacheRef.current.get(cacheKey);
          if (cached) {
            return cached;
          }
        }
        // Generate path with position-consistent node data
        path = generateModeAwareConnectionPath(
          {
            sourceNodeId: connection.sourceNodeId,
            sourcePortId: connection.sourcePortId,
            targetNodeId: connection.targetNodeId,
            targetPortId: connection.targetPortId,
          },
          nodesForPath,
          nodeVariant,
          modeId || 'workflow',
          // Config is used by workflow (bezier) generator only.
          modeId === 'workflow' ? { arrowOffset: 12 } : undefined
        );
      }

      const finalPath = path;

      // Track endpoint positions for smooth interpolation during dragging
      if (sourceNode && targetNode) {
        const sourcePos = dragSnapshot.get(connection.sourceNodeId) || sourceNode;
        const targetPos = dragSnapshot.get(connection.targetNodeId) || targetNode;

        // Get actual port anchor positions for endpoint tracking
        const portAnchors = getModeAwarePortAnchors(
          {
            sourceNodeId: connection.sourceNodeId,
            sourcePortId: connection.sourcePortId,
            targetNodeId: connection.targetNodeId,
            targetPortId: connection.targetPortId,
          },
          [
            { ...sourceNode, x: sourcePos.x, y: sourcePos.y },
            { ...targetNode, x: targetPos.x, y: targetPos.y }
          ],
          nodeVariant,
          modeId || 'workflow'
        );

        if (portAnchors) {
          updateEndpointPositions(connection, {
            source: { x: portAnchors.source.x, y: portAnchors.source.y, lastUpdate: Date.now() },
            target: { x: portAnchors.target.x, y: portAnchors.target.y, lastUpdate: Date.now() }
          });
        }
      }

      // Cache result only if using committed positions
      if (!useDragPositions && cacheKey && !anyDragActive) {
        pathCacheRef.current.set(cacheKey, finalPath);
        cleanupCacheIfNeeded();
      }
      return finalPath;
    },
    [nodeMap, nodeVariant, modeId, nodes, cleanupCacheIfNeeded, buildCacheKey, decideStickySide, updateEndpointPositions, isAnyDragging]
  );

  return {
    getConnectionPath,
    updateDragPosition,
    clearAllDragPositions,
    clearCache,
    getConnectionEndpoints,
  };
}

export default useConnectionPaths;
