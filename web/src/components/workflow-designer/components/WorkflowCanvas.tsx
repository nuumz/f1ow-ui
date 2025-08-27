/* eslint-disable @typescript-eslint/no-explicit-any */
import type React from 'react';
import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { createNodeElements, createNodeGroups } from '../utils/node-elements';
import type { PortDatum } from '../utils/ports-hit-test';
import type { WorkflowNode, Connection, NodeVariant, CanvasTransform } from '../types';
import { getNodeTypeInfo } from '../types/nodes';
import {
  useWorkflowContext,
  useWorkflowNodes,
  useWorkflowConnections,
  useSelectedNodes,
  useDragState,
  useCanvasTransform,
  useConnectionState,
  useDesignerMode,
} from '../contexts/WorkflowContext';
import { useWorkflowVirtualization } from '../hooks/useVirtualization';
import {
  getNodeColor,
  getNodeIcon,
  getNodeShape,
  getShapeAwareDimensions,
  getNodeShapePath,
  NodeTypes,
} from '../utils/node-utils';
import { renderIconUse } from '../utils/icon-symbols';
import { useConnectionPaths } from '../hooks/useConnectionPaths';
import {
  getArrowMarkerForMode as getArrowMarkerForModeUtil,
  ensureArrowMarkers,
} from '../utils/marker-utils';
import { GridPerformanceMonitor } from '../utils/performance-monitor';
import { createGrid } from '../utils/grid-patterns';
import {
  PERFORMANCE_CONSTANTS,
  GRID_CONSTANTS,
  type CallbackPriority,
} from '../utils/canvas-constants';
import {
  getConnectionGroupInfo,
  renderConnectionPreviewPath,
  tagSidePortsDuringConnection,
  updatePortsVisualState,
  type DesignerMode,
} from '../utils/connection-utils';
import { getVisibleCanvasBounds } from '../utils/canvas-utils';
import {
  computeRectPortPositions,
  computeCirclePortPositions,
  computeDiamondPortPositions,
} from '../utils/port-positioning';
import { canBottomPortAcceptConnection } from '../utils/port-visuals';
import { createFilledPolygonFromPath } from '../utils/path-generation';
import {
  createD3SelectionCache,
  createRafScheduler,
  createZIndexManager,
} from '../utils/d3-manager';
import { createPortDragCallbacks, resolveDragEndTarget } from '../utils/drag-drop-helpers';
import { createNodeDragBehavior } from '../utils/node-drag';
import { renderConnectionsLayer } from '../utils/connection-dom';
import { groupConnectionsBySideAndPort } from '../utils/connection-utils';
import {
  renderOutputPorts,
  renderSidePorts,
  renderBottomPorts,
  renderInputPorts,
} from '../utils/ports-dom';
import {
  attachNodeBackgroundEvents,
  applyNodeVisualState,
  updateArchOutline,
  updateIconsAndLabels,
  updateNodeBackgroundPath,
} from '../utils/nodes-dom';

import {
  announce,
  ensureFocusStyles,
  setupRovingTabIndex,
  attachRovingHandlers,
} from '../utils/accessibility-helpers';
import {
  processBatchedVisualUpdates,
  processBatchedConnectionUpdates,
  processLiveDragConnectionUpdates,
  updateDraggedNodePosition,
  resetNodeVisualStyle,
  clearAllVisualCaches,
  clearAllDragTracking,
  type DragPositionConfig,
  type VisualCacheConfig,
} from '../utils/visual-state-manager';

type MarkerState = 'default' | 'selected' | 'hover';

interface DragConnectionData {
  nodeId: string;
  portId: string;
  type: 'input' | 'output';
}

interface WorkflowCanvasProps {
  svgRef: React.RefObject<SVGSVGElement>;
  nodes: WorkflowNode[];
  connections: Connection[];
  showGrid: boolean;
  canvasTransform: CanvasTransform;
  nodeVariant: NodeVariant;
  selectedNodes: Set<string>;
  selectedConnection?: Connection | null;
  isNodeSelected: (nodeId: string) => boolean;
  isConnecting: boolean;
  connectionStart: {
    nodeId: string;
    portId: string;
    type: 'input' | 'output';
  } | null;
  connectionPreview: { x: number; y: number } | null;
  onNodeClick: (node: WorkflowNode, ctrlKey?: boolean) => void;
  onNodeDoubleClick: (node: WorkflowNode, event?: any) => void;
  onNodeDrag: (nodeId: string, x: number, y: number) => void;
  onConnectionClick: (connection: Connection) => void;
  onCanvasClick: () => void;
  onCanvasMouseMove: (x: number, y: number) => void;
  // Optional port event handlers (provided by WorkflowDesigner handlers)
  onPortClick?: (nodeId: string, portId: string, portType: 'input' | 'output') => void;
  onPortDragStart?: (nodeId: string, portId: string, portType: 'input' | 'output') => void;
  onPortDrag?: (x: number, y: number) => void;
  onPortDragEnd?: (
    targetNodeId?: string,
    targetPortId?: string,
    canvasX?: number,
    canvasY?: number
  ) => void;
  canDropOnPort?: (nodeId: string, portId: string, type: 'input' | 'output') => boolean;
  // Optional node-level drop validation (used for background drop target validation)
  canDropOnNode?: (targetNodeId: string) => boolean;
  // Optional hooks for zoom/transform lifecycle used in the component
  onTransformChange?: (transform: d3.ZoomTransform) => void;
  onRegisterZoomBehavior?: (zoom: d3.ZoomBehavior<SVGSVGElement, unknown>) => void;
  onZoomLevelChange?: (k: number) => void;
  onPlusButtonClick?: (nodeId: string, portId: string) => void;
}

function WorkflowCanvas({
  svgRef,
  nodes,
  connections,
  showGrid,
  canvasTransform,
  nodeVariant,
  selectedNodes,
  selectedConnection,
  isNodeSelected,
  isConnecting,
  connectionStart,
  connectionPreview,
  onNodeClick,
  onNodeDoubleClick: _onNodeDoubleClick,
  onNodeDrag,
  onConnectionClick,
  onCanvasClick,
  onCanvasMouseMove,
  onPortClick: onPortClickProp,
  onPortDragStart: onPortDragStartProp,
  onPortDrag: onPortDragProp,
  onPortDragEnd: onPortDragEndProp,
  canDropOnPort: canDropOnPortProp,
  canDropOnNode: _canDropOnNodeProp,
  onTransformChange,
  onRegisterZoomBehavior,
  onZoomLevelChange,
  onPlusButtonClick: _onPlusButtonClick,
}: WorkflowCanvasProps) {
  // Keep latest connection state in a ref to avoid stale closures inside D3 handlers
  const isConnectingRef = useRef(isConnecting);
  const connectionStartRef = useRef(connectionStart);
  useEffect(() => {
    isConnectingRef.current = isConnecting;
    connectionStartRef.current = connectionStart;
  }, [isConnecting, connectionStart]);

  // Use optimized selector hooks instead of full context
  // Global shortcuts handled elsewhere; duplicate handler removed
  const {
    isDragging: isContextDragging,
    getDraggedNodeId,
    startDragging,
    updateDragPosition,
    endDragging,
    canDropOnPort: canDropOnPortFromContext,
    // canDropOnNode: canDropOnNodeFromContext,
    dispatch,
  } = useWorkflowContext();

  // Use specific selector hooks for performance
  const workflowNodes = useWorkflowNodes();
  const workflowConnections = useWorkflowConnections();
  const contextSelectedNodes = useSelectedNodes();
  const dragStateFromContext = useDragState();
  const canvasTransformFromContext = useCanvasTransform();
  const connectionStateFromContext = useConnectionState();
  const designerModeFromContext = useDesignerMode();

  // Virtualization for performance with large workflows
  const viewport = useMemo(() => {
    if (!canvasTransform && !canvasTransformFromContext) {
      return { x: 0, y: 0, width: 1200, height: 800, scale: 1 };
    }
    const transform = canvasTransform || canvasTransformFromContext;
    return {
      x: -transform.x / transform.k,
      y: -transform.y / transform.k,
      width: 1200 / transform.k, // Approximate viewport width
      height: 800 / transform.k, // Approximate viewport height
      scale: transform.k,
    };
  }, [canvasTransform, canvasTransformFromContext]);

  const virtualizedWorkflow = useWorkflowVirtualization(
    workflowNodes,
    workflowConnections,
    canvasTransform || canvasTransformFromContext,
    viewport,
    {
      virtualization: {
        minNodesForVirtualization: 30, // Start virtualization at 30 nodes
        bufferSize: 400, // Larger buffer for smooth scrolling
      },
      levelOfDetail: {
        lowDetailThreshold: 0.4,
        hidePortsThreshold: 0.25,
        hideLabelsThreshold: 0.15,
      },
    }
  );

  // Use virtualized data when available
  const effectiveNodes = nodes || virtualizedWorkflow.visibleNodes;
  const effectiveConnections =
    connections || virtualizedWorkflow.connectionOptimization.connections;

  // Create a minimal state object for components that still need it
  const workflowContextState = useMemo(() => {
    // Use virtualized data when available for better performance
    const actualNodes = effectiveNodes;
    const actualConnections = effectiveConnections;
    const actualCanvasTransform = canvasTransform || canvasTransformFromContext;
    const actualSelectedNodes =
      selectedNodes || new Set(contextSelectedNodes.map((n: any) => n.id));

    return {
      nodes: actualNodes,
      connections: actualConnections,
      selectedNodes: actualSelectedNodes,
      designerMode: designerModeFromContext,
      canvasTransform: actualCanvasTransform,
      draggingState: dragStateFromContext,
      connectionState: connectionStateFromContext,
      // Add virtualization metadata
      virtualization: {
        active: virtualizedWorkflow.renderMetrics.virtualizationActive,
        nodesRendered: virtualizedWorkflow.renderMetrics.nodesRendered,
        totalNodes:
          virtualizedWorkflow.renderMetrics.nodesRendered +
          virtualizedWorkflow.renderMetrics.nodesSkipped,
        renderConfig: virtualizedWorkflow.levelOfDetail.renderConfig,
      },
    };
  }, [
    effectiveNodes,
    effectiveConnections,
    canvasTransform,
    canvasTransformFromContext,
    selectedNodes,
    contextSelectedNodes,
    connectionStateFromContext,
    dragStateFromContext,
    designerModeFromContext,
    virtualizedWorkflow,
  ]);

  // Prefer prop override, fallback to context implementation
  const canDropOnPort = canDropOnPortProp ?? canDropOnPortFromContext;
  // Note: canDropOnNode is provided via props/context but not directly used in this component now.
  // Internal refs/utilities used across effects
  const highlightRafRef = useRef<number | null>(null);
  const pendingPortHighlightsRef = useRef<
    Array<{
      key: string;
      canDrop: boolean;
      group: d3.Selection<any, any, any, any>;
    }>
  >([]);
  const selectionCache = useMemo(() => createD3SelectionCache(() => svgRef.current), [svgRef]);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const batchedConnectionUpdateRef = useRef<number | null>(null);
  const batchedVisualUpdateRef = useRef<number | null>(null);
  // Queues used by batching logic elsewhere in the component
  const connectionUpdateQueueRef = useRef<Set<string>>(new Set());
  const visualUpdateQueueRef = useRef<Set<string>>(new Set());

  // Minimal local init flag used by effects below
  const [isInitialized, setIsInitialized] = useState(false);

  // Capture connection drag start reliably across async handlers
  const dragConnectionDataRef = useRef<DragConnectionData | null>(null);
  // Track if a keyboard-driven connection is in progress for UX hints
  const keyboardConnectingRef = useRef<boolean>(false);

  // Architecture outline visibility is driven by NodeTypes info now

  // Connection interaction shims (forward to context connection state via dispatch helpers)
  const onPortDragStart = useCallback(
    (nodeId: string, portId: string, type: 'input' | 'output') => {
      // Guard: if context says we're already connecting, ignore secondary starts
      if (isConnectingRef.current && connectionStartRef.current) {
        // If it's the same port, silently ignore; otherwise drop to avoid conflicting gestures
        const cs = connectionStartRef.current;
        if (cs?.nodeId === nodeId && cs?.portId === portId && cs?.type === type) {
          return;
        }
      }
      // Always capture locally first to avoid stale state issues
      dragConnectionDataRef.current = { nodeId, portId, type };
      if (onPortDragStartProp) {
        onPortDragStartProp(nodeId, portId, type);
      } else {
        dispatch?.({
          type: 'START_CONNECTION',
          payload: { nodeId, portId, type },
        });
      }
    },
    [dispatch, onPortDragStartProp]
  );

  const onPortDrag = useCallback(
    (x: number, y: number) => {
      if (onPortDragProp) {
        onPortDragProp(x, y);
      } else {
        dispatch?.({ type: 'UPDATE_CONNECTION_PREVIEW', payload: { x, y } });
      }
    },
    [dispatch, onPortDragProp]
  );

  const onPortDragEnd = useCallback(
    (targetNodeId?: string, targetPortId?: string, canvasX?: number, canvasY?: number) => {
      // Prefer external handler if provided (unified flow with operations + validation)
      if (onPortDragEndProp) {
        onPortDragEndProp(targetNodeId, targetPortId, canvasX, canvasY);
        // Cleanup local ref regardless
        dragConnectionDataRef.current = null;
        return;
      }

      // Fallback: use locally captured start first, then context state
      const start =
        dragConnectionDataRef.current ?? workflowContextState.connectionState.connectionStart;
      if (!start) {
        dispatch?.({ type: 'CLEAR_CONNECTION_STATE' });
        dragConnectionDataRef.current = null;
        return;
      }
      if (targetNodeId && targetPortId) {
        const newConn: Connection = {
          id: `${start.nodeId}:${start.portId}->${targetNodeId}:${targetPortId}:${Date.now()}`,
          sourceNodeId: start.type === 'output' ? start.nodeId : targetNodeId,
          sourcePortId: start.type === 'output' ? start.portId : targetPortId,
          targetNodeId: start.type === 'output' ? targetNodeId : start.nodeId,
          targetPortId: start.type === 'output' ? targetPortId : start.portId,
        };
        dispatch?.({ type: 'ADD_CONNECTION', payload: newConn });
      }
      dispatch?.({ type: 'CLEAR_CONNECTION_STATE' });
      dragConnectionDataRef.current = null;
    },
    [dispatch, onPortDragEndProp, workflowContextState.connectionState.connectionStart]
  );

  const onPortClick = useCallback(
    (nodeId: string, portId: string, portType: 'input' | 'output') => {
      // Delegate to external if provided
      onPortClickProp?.(nodeId, portId, portType);
    },
    [onPortClickProp]
  );

  const flushPortHighlights = useCallback(() => {
    const items = pendingPortHighlightsRef.current;
    if (items.length === 0) {
      highlightRafRef.current = null;
      return;
    }
    // Process all pending highlight updates
    for (const item of items) {
      try {
        item.group.classed('can-dropped', item.canDrop);
      } catch {
        // ignore DOM errors
      }
    }
    pendingPortHighlightsRef.current = [];
    highlightRafRef.current = null;
  }, []);

  const scheduleHighlightFlush = useCallback(() => {
    if (highlightRafRef.current !== null) {
      return;
    }
    highlightRafRef.current = requestAnimationFrame(() => {
      flushPortHighlights();
    });
  }, [flushPortHighlights]);

  const updatePortHighlighting = useCallback(
    (portKey: string, canDrop: boolean, portGroup: d3.Selection<any, any, any, any>) => {
      pendingPortHighlightsRef.current.push({
        key: portKey,
        canDrop,
        group: portGroup,
      });
      scheduleHighlightFlush();
    },
    [scheduleHighlightFlush]
  );

  // Cleanup timeout on unmount
  // No timeout-based highlight cleanup needed now (rAF based)
  useEffect(
    () => () => {
      if (highlightRafRef.current) {
        cancelAnimationFrame(highlightRafRef.current);
      }
    },
    []
  );

  // ========== CACHE MANAGEMENT CALLBACKS ==========
  // Cached D3 selection getter for performance
  const getCachedSelection = useCallback(
    (type: 'svg' | 'nodeLayer' | 'connectionLayer' | 'gridLayer') =>
      selectionCache.getCachedSelection(type) as any,
    [selectionCache]
  );

  // Debug logger that respects lint rule (only allow warn/error); gate others in dev
  const dbg = useMemo(
    () =>
      ({
        log: (..._args: unknown[]) => {
          // no-op to satisfy no-console lint
        },
        warn: (...args: unknown[]) => console.warn(...args),
        error: (...args: unknown[]) => console.error(...args),
      }) as const,
    []
  );

  // Comprehensive cleanup for all timeouts, RAF callbacks, and refs on unmount
  useEffect(() => {
    const cleanup = () => {
      // Clear all timeout refs
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
        updateTimeoutRef.current = null;
      }

      // Clear all RAF refs
      if (batchedConnectionUpdateRef.current) {
        cancelAnimationFrame(batchedConnectionUpdateRef.current);
        batchedConnectionUpdateRef.current = null;
      }
      if (batchedVisualUpdateRef.current) {
        cancelAnimationFrame(batchedVisualUpdateRef.current);
        batchedVisualUpdateRef.current = null;
      }
      if (highlightRafRef.current) {
        cancelAnimationFrame(highlightRafRef.current);
        highlightRafRef.current = null;
      }

      // Clear timeout refs that might be referenced later in the component
      if (dragStateCleanupRef.current) {
        clearTimeout(dragStateCleanupRef.current);
        dragStateCleanupRef.current = null;
      }

      // Clear grid performance monitor
      if (gridPerformanceRef.current) {
        gridPerformanceRef.current = null;
      }

      // No local RAF scheduled flag anymore
    };

    return cleanup;
  }, []);

  // One-time setup: inject focus styles and set up Escape-to-cancel for keyboard connections
  useEffect(() => {
    ensureFocusStyles();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isConnectingRef.current) {
        e.stopPropagation();
        dispatch?.({ type: 'CLEAR_CONNECTION_STATE' });
        keyboardConnectingRef.current = false;
        announce('Connection cancelled');
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as any);
  }, [dispatch]);

  // Enhanced connection system initialization removed - simplified to standard paths

  // Enhanced connection manager viewport updates removed

  // Performance monitoring removed - simplified architecture

  // Track current transform with ref for immediate access
  const currentTransformRef = useRef(canvasTransform);

  // Centralized connection path generator + drag overrides
  const {
    getConnectionPath: getConnectionPathFromHook,
    updateDragPosition: updateConnDragPos,
    clearAllDragPositions,
    clearCache: clearConnCache,
  } = useConnectionPaths(nodes, nodeVariant, workflowContextState.designerMode as DesignerMode);

  // Stable alias for downstream usage
  const getConnectionPath = useCallback(
    (connection: Connection, useDragPositions = false) =>
      getConnectionPathFromHook(connection, useDragPositions),
    [getConnectionPathFromHook]
  );

  // Helper functions to reduce cognitive complexity
  const getArrowMarkerForMode = useCallback(
    (isWorkflowMode: boolean, state: MarkerState) =>
      getArrowMarkerForModeUtil(isWorkflowMode, state),
    []
  );

  // getLeftArrowMarker helper removed (unused)

  /**
   * Helper function to determine connection direction and appropriate arrow marker
   * Now includes mode-specific styling for workflow vs architecture modes
   */
  const getConnectionMarker = useCallback(
    (connection: Connection, state: 'default' | 'selected' | 'hover' = 'default') => {
      const sourceNode = nodes.find((n: WorkflowNode) => n.id === connection.sourceNodeId);
      const targetNode = nodes.find((n: WorkflowNode) => n.id === connection.targetNodeId);

      if (!sourceNode || !targetNode) {
        return 'url(#arrowhead)';
      }

      // Default to workflow styling unless mode is explicitly 'architecture'.
      // This prevents accidental purple (architecture) arrows when mode is undefined or other.
      const isWorkflowMode = workflowContextState.designerMode !== 'architecture';
      // Use a single auto-oriented marker per mode to ensure consistent arrowhead position
      return getArrowMarkerForMode(isWorkflowMode, state);
    },
    [nodes, workflowContextState.designerMode, getArrowMarkerForMode]
  );
  useEffect(() => {
    currentTransformRef.current = canvasTransform;
  }, [canvasTransform]);

  // Drag state with context integration
  const draggedElementRef = useRef<d3.Selection<any, any, any, any> | null>(null);
  const draggedNodeElementRef = useRef<SVGGElement | null>(null);
  const nodeLayerRef = useRef<SVGGElement | null>(null);
  const allNodeElementsRef = useRef<Map<string, SVGGElement>>(new Map());

  // Enhanced dragging state management for stability with context integration
  const dragStateCleanupRef = useRef<NodeJS.Timeout | null>(null);

  // Use context-based dragging state
  const isDragging = isContextDragging();
  const draggedNodeId = getDraggedNodeId();

  // Cache refs for performance with size limits to prevent memory leaks
  const gridCacheRef = useRef<{
    transform: string;
    pattern: string;
    lastRenderTime: number;
    viewport: { width: number; height: number };
    bounds: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      width: number;
      height: number;
    };
  } | null>(null);
  const nodePositionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Grid performance monitoring using centralized utilities
  const gridPerformanceRef = useRef<GridPerformanceMonitor | null>(null);

  // Initialize grid performance monitor
  useEffect(() => {
    // Prefer nullish coalescing assignment for readability
    gridPerformanceRef.current ??= new GridPerformanceMonitor();
    // Start development monitoring if in dev mode (removed for production bundle slimming)
  }, []);

  // Cache size limits to prevent memory issues - using constants
  const MAX_CACHE_SIZE = PERFORMANCE_CONSTANTS.MAX_CACHE_SIZE;
  const CACHE_CLEANUP_THRESHOLD = PERFORMANCE_CONSTANTS.CACHE_CLEANUP_THRESHOLD;
  const GRID_CACHE_DURATION = PERFORMANCE_CONSTANTS.GRID_CACHE_DURATION;

  // High-performance pattern-based grid creation with enhanced caching and performance monitoring
  const createGridCallback = useCallback(
    (
      gridLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
      transform: { x: number; y: number; k: number },
      viewportWidth: number,
      viewportHeight: number
    ) => {
      createGrid(gridLayer, transform, viewportWidth, viewportHeight, {
        showGrid,
        gridCacheRef,
        gridPerformanceRef,
        getVisibleCanvasBounds,
        GRID_CONSTANTS,
        dbg,
      });
    },
    [showGrid, dbg]
  );

  // Enhanced cache and memory management utilities (connection path cache handled by hook)
  const cleanupCaches = useCallback(() => {
    // Clean node position cache if too large (reduced logging)
    if (nodePositionCacheRef.current.size > CACHE_CLEANUP_THRESHOLD) {
      const keysToDelete = Array.from(nodePositionCacheRef.current.keys()).slice(
        0,
        nodePositionCacheRef.current.size - MAX_CACHE_SIZE
      );
      keysToDelete.forEach((key) => nodePositionCacheRef.current.delete(key));
      if (process.env.NODE_ENV === 'development') {
        dbg.warn(`🧹 Cleaned position cache: ${keysToDelete.length} entries`);
      }
    }

    // Reset grid cache if expired (no logging needed)
    const now = performance.now();
    if (
      gridCacheRef.current &&
      now - gridCacheRef.current.lastRenderTime > GRID_CACHE_DURATION * 2
    ) {
      gridCacheRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Constants don't need to be included in dependencies

  // Schedule regular cache cleanup every 30 seconds
  useEffect(() => {
    const cleanupInterval = setInterval(cleanupCaches, 30000);
    return () => clearInterval(cleanupInterval);
  }, [cleanupCaches]);

  // Enhanced RAF scheduling system with priority queues
  const rafScheduler = useMemo(() => createRafScheduler(), []);
  const scheduleRAF = useCallback(
    (callback: () => void, priority: CallbackPriority = 'normal') =>
      rafScheduler.scheduleRAF(callback, priority),
    [rafScheduler]
  );

  // Enhanced Z-Index Management with change detection to reduce DOM manipulation
  const zIndexManager = useMemo(
    () =>
      createZIndexManager({
        getNodeLayer: () => nodeLayerRef.current,
        getAllNodeElements: () => allNodeElementsRef.current,
        isNodeSelected,
        isDragging: () => isContextDragging(),
        getDraggedNodeId,
        scheduleRAF,
      }),
    [isNodeSelected, scheduleRAF, isContextDragging, getDraggedNodeId]
  );
  const organizeNodeZIndex = useCallback(() => zIndexManager.organizeNodeZIndex(), [zIndexManager]);
  // setNodeAsDragging no longer used directly; zIndexManager manages layering internally.

  // Optimized node lookup with memoization
  const nodeMap = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    nodes.forEach((node: WorkflowNode) => map.set(node.id, node));
    return map;
  }, [nodes]);

  // Stable reference for selectedNodes to prevent unnecessary re-renders
  const selectedNodesRef = useRef(selectedNodes);
  selectedNodesRef.current = selectedNodes;

  // Throttle drag updates for better performance
  const lastDragUpdateRef = useRef(0);
  const dragUpdateThrottle = 16; // ~60fps for better performance balance

  // Track last updated paths removed; hook handles caching

  // Track current drag positions to prevent position conflicts
  const currentDragPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Helper function to create a filled polygon from a path with thickness
  const createFilledPolygonFromPathCallback = useCallback(
    (pathString: string, thickness: number = 6): string => {
      return createFilledPolygonFromPath(pathString, thickness, svgRef.current);
    },
    [svgRef]
  );

  // Removed manual trimPathForArrow. Arrow clearance is now handled in utils
  // via calculateArrowAdjustedPosition and box projections.

  // Connection path is provided by useConnectionPaths hook (see alias above)

  // Memoized configurable dimensions calculation (shape-aware)
  const getConfigurableDimensions = useMemo(() => {
    const dimensionsCache = new Map<string, any>();

    return (node: WorkflowNode) => {
      const cacheKey = `${node.id}-${nodeVariant}-${
        workflowContextState.designerMode || 'workflow'
      }`;
      const cached = dimensionsCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const shapeDimensions = getShapeAwareDimensions(node);

      // Architecture mode: fixed rounded-square sizing + right-side labels
      if (workflowContextState.designerMode === 'architecture') {
        const ARCH_SIZE = 56; // square size (reduced from 64)
        const result = {
          ...shapeDimensions,
          width: ARCH_SIZE,
          height: ARCH_SIZE,
          iconOffset: { x: 0, y: 0 },
          labelOffset: { x: 0, y: 0 }, // label positioning is handled later (to the right)
          portRadius: 5,
          iconSize: 28,
          fontSize: 14,
        };
        dimensionsCache.set(cacheKey, result);
        return result;
      }

      // Adjust dimensions based on variant (workflow mode)
      const result =
        nodeVariant === 'compact'
          ? {
              ...shapeDimensions,
              width: shapeDimensions.width * 0.8,
              height: shapeDimensions.height * 0.8,
              portRadius: shapeDimensions.portRadius || 6,
            }
          : {
              ...shapeDimensions,
              portRadius: shapeDimensions.portRadius || 6,
            };

      dimensionsCache.set(cacheKey, result);
      return result;
    };
  }, [nodeVariant, workflowContextState.designerMode]);

  // Helper: shape-specific port positions calculators (extracted to reduce complexity)
  // Rect-like (rectangle/square) port positions. For squares, the rendered path uses an inner 0.8 scale
  // (see shape-utils.getShapePath for 'square'), so use the inner edge for port centers to match
  // connection anchors from shape-utils.getPortPositions.
  // Memoized port positions calculation using configurable dimensions
  const getConfigurablePortPositions = useMemo(() => {
    const positionsCache = new Map<string, any>();

    return (node: WorkflowNode, portType: 'input' | 'output') => {
      const cacheKey = `${node.id}-${portType}-${nodeVariant}-${
        workflowContextState.designerMode || 'workflow'
      }`;

      if (positionsCache.has(cacheKey)) {
        return positionsCache.get(cacheKey);
      }

      const shape = getNodeShape(node.type);
      const dimensions = getConfigurableDimensions(node);
      const portCount = portType === 'input' ? node.inputs.length : node.outputs.length;

      let positions: Array<{ x: number; y: number }> = [];
      if (shape === 'rectangle' || shape === 'square') {
        positions = computeRectPortPositions(dimensions, portCount, portType, shape);
      } else if (shape === 'circle') {
        positions = computeCirclePortPositions(dimensions, portCount);
      } else if (shape === 'diamond') {
        positions = computeDiamondPortPositions(dimensions, portCount, portType);
      }

      positionsCache.set(cacheKey, positions);
      return positions;
    };
  }, [nodeVariant, workflowContextState.designerMode, getConfigurableDimensions]);

  // Hit-test radius accessor to reuse across drag-end handlers
  const getHitTestPortRadius = useCallback(
    (pd: PortDatum) => getConfigurableDimensions(pd.nodeData).portRadius || 6,
    [getConfigurableDimensions]
  );

  // Use imported resolveDragEndTarget util with getHitTestPortRadius

  // Removed local bottom port layout; use calculatePortPosition for accuracy across modes/variants

  // Enhanced visual feedback system with batching and caching
  const processBatchedVisualUpdatesCallback = useCallback(() => {
    const hasMore = processBatchedVisualUpdates(
      visualUpdateQueueRef.current,
      allNodeElementsRef.current,
      () => {
        batchedVisualUpdateRef.current = null;
      }
    );

    if (hasMore) {
      batchedVisualUpdateRef.current = requestAnimationFrame(processBatchedVisualUpdatesCallback);
    }
  }, []);

  // Unified drop state management
  // setDropFeedback removed; visual feedback handled via CSS and existing state

  // applyDragVisualStyle removed; we set styles directly where needed

  // Memoized connection lookup for better drag performance
  const nodeConnectionsMap = useMemo(() => {
    const map = new Map<string, Connection[]>();
    connections.forEach((conn: Connection) => {
      // Index by source node
      if (!map.has(conn.sourceNodeId)) {
        map.set(conn.sourceNodeId, []);
      }
      map.get(conn.sourceNodeId)!.push(conn);

      // Index by target node (if different from source)
      if (conn.targetNodeId !== conn.sourceNodeId) {
        if (!map.has(conn.targetNodeId)) {
          map.set(conn.targetNodeId, []);
        }
        map.get(conn.targetNodeId)!.push(conn);
      }
    });
    return map;
  }, [connections]);

  // Batched connection update system for better performance (after drag end)
  const processBatchedConnectionUpdatesCallback = useCallback(() => {
    const connectionLayer = getCachedSelection('connectionLayer');
    if (!connectionLayer) {
      return;
    }

    const hasMore = processBatchedConnectionUpdates(
      connectionUpdateQueueRef.current,
      nodeConnectionsMap,
      connectionLayer,
      getConnectionPath,
      () => {
        batchedConnectionUpdateRef.current = null;
      }
    );

    if (hasMore) {
      batchedConnectionUpdateRef.current = requestAnimationFrame(
        processBatchedConnectionUpdatesCallback
      );
    }
  }, [nodeConnectionsMap, getConnectionPath, getCachedSelection]);

  // Live drag connection updates for immediate feedback during drag
  const processLiveDragConnectionUpdatesCallback = useCallback(() => {
    const connectionLayer = getCachedSelection('connectionLayer');
    if (!connectionLayer || !draggedNodeId) {
      return;
    }

    const hasMore = processLiveDragConnectionUpdates(
      connectionUpdateQueueRef.current,
      nodeConnectionsMap,
      connectionLayer,
      getConnectionPath,
      draggedNodeId,
      () => {
        batchedConnectionUpdateRef.current = null;
      }
    );

    if (hasMore) {
      batchedConnectionUpdateRef.current = requestAnimationFrame(
        processLiveDragConnectionUpdatesCallback
      );
    }
  }, [nodeConnectionsMap, getConnectionPath, getCachedSelection, draggedNodeId]);

  const updateDraggedNodePositionCallback = useCallback(
    (nodeId: string, newX: number, newY: number) => {
      const dragConfig: DragPositionConfig = {
        draggedElement: draggedElementRef.current,
        currentDragPositions: currentDragPositionsRef.current,
        updateConnDragPos,
        nodeConnectionsMap,
        connectionUpdateQueue: connectionUpdateQueueRef.current,
        lastDragUpdate: lastDragUpdateRef,
        dragUpdateThrottle,
        startBatchedConnectionUpdates: () => {
          if (!batchedConnectionUpdateRef.current) {
            batchedConnectionUpdateRef.current = requestAnimationFrame(
              processBatchedConnectionUpdatesCallback
            );
          }
        },
        startLiveDragConnectionUpdates: () => {
          if (!batchedConnectionUpdateRef.current) {
            batchedConnectionUpdateRef.current = requestAnimationFrame(
              processLiveDragConnectionUpdatesCallback
            );
          }
        },
      };

      updateDraggedNodePosition(nodeId, newX, newY, dragConfig);
    },
    [
      nodeConnectionsMap,
      dragUpdateThrottle,
      updateConnDragPos,
      processBatchedConnectionUpdatesCallback,
      processLiveDragConnectionUpdatesCallback,
    ]
  );

  const resetNodeVisualStyleCallback = useCallback(
    (nodeElement: any, nodeId: string) => {
      resetNodeVisualStyle(nodeElement, nodeId, isNodeSelected, nodeMap);
    },
    [isNodeSelected, nodeMap]
  );

  // Enhanced cache management with memory optimization
  const clearAllCachesCallback = useCallback(() => {
    const cacheConfig: VisualCacheConfig = {
      nodePositionCache: nodePositionCacheRef.current,
      currentDragPositions: currentDragPositionsRef.current,
      connectionUpdateQueue: connectionUpdateQueueRef.current,
      visualUpdateQueue: visualUpdateQueueRef.current,
      clearConnCache,
      clearAllDragPositions,
      zIndexManager,
      rafScheduler,
      batchedConnectionUpdateRef,
      batchedVisualUpdateRef,
    };

    clearAllVisualCaches(cacheConfig);
  }, [clearConnCache, clearAllDragPositions, zIndexManager, rafScheduler]);

  // Clear caches when nodes change
  useEffect(() => {
    clearAllCachesCallback();
  }, [nodes, clearAllCachesCallback]);

  // Clear connection paths when connections change
  useEffect(() => {
    clearConnCache();
  }, [connections, clearConnCache]);

  // Immediate z-index organization for selection changes
  useEffect(() => {
    if (!isDragging && isInitialized) {
      // Use immediate update for selection changes to ensure proper layering
      const nodeLayer = nodeLayerRef.current;
      if (!nodeLayer || allNodeElementsRef.current.size === 0) {
        return;
      }

      const normalNodes: SVGGElement[] = [];
      const selectedNodes: SVGGElement[] = [];
      const draggingNodes: SVGGElement[] = [];

      allNodeElementsRef.current.forEach((element, nodeId) => {
        if (!nodeLayer.contains(element)) {
          return;
        }

        const isNodeDragging = isDragging && nodeId === draggedNodeId;
        const isSelected = isNodeSelected(nodeId);

        if (isNodeDragging) {
          draggingNodes.push(element);
        } else if (isSelected) {
          selectedNodes.push(element);
        } else {
          normalNodes.push(element);
        }
      });

      // Reorder DOM elements immediately: normal → selected → dragging
      const orderedElements = [...normalNodes, ...selectedNodes, ...draggingNodes];

      orderedElements.forEach((element) => {
        if (nodeLayer.contains(element) && nodeLayer.lastChild !== element) {
          nodeLayer.appendChild(element);
        }
      });
    }
  }, [selectedNodes, isNodeSelected, isInitialized, isDragging, draggedNodeId]);

  // Monitor drag state changes to clean up DOM classes
  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);

    // If we're not dragging, remove all dragging classes
    if (!isDragging) {
      svg.selectAll('.node.dragging').classed('dragging', false);
      // Clear draggedElementRef when not dragging
      if (draggedElementRef.current) {
        draggedElementRef.current = null;
      }
    }
  }, [isDragging, draggedNodeId, svgRef]);

  // Main D3 rendering effect - soon: nodes-focused (connections handled separately)
  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    try {
      // Copy refs at the start of the effect for cleanup
      const currentSvgRef = svgRef.current;

      const svg = d3.select(currentSvgRef);
      // Initialize or reuse defs (do not clear to preserve markers between renders)
      let defs = svg.select<SVGDefsElement>('defs');
      if (defs.empty()) {
        defs = svg.append('defs');
      }

      // Background rect (ensure single)
      let bg = svg.select<SVGRectElement>('rect.svg-canvas-background');
      if (bg.empty()) {
        bg = svg.append('rect').attr('class', 'svg-canvas-background');
      }
      bg.attr('width', '100%').attr('height', '100%').attr('fill', '#f7f7f7');

      // Arrow markers with direction-aware positioning and optimized refX
      // Create directional arrow markers once (skip if already present)
      ensureArrowMarkers(
        defs as unknown as d3.Selection<SVGDefsElement, unknown, d3.BaseType, unknown>
      );

      // Layer hierarchy (ensure single instances)
      let g = svg.select<SVGGElement>('g.canvas-root');
      if (g.empty()) {
        g = svg.append('g').attr('class', 'canvas-root');
      }
      const gridLayer = g.select<SVGGElement>('g.grid-layer');
      if (gridLayer.empty()) {
        g.append('g').attr('class', 'grid-layer').style('pointer-events', 'none');
      }
      let mainNodeLayer = g.select<SVGGElement>('g.node-layer');
      if (mainNodeLayer.empty()) {
        mainNodeLayer = g.append('g').attr('class', 'node-layer');
      }
      const connectionLayer = g.select<SVGGElement>('g.connection-layer');
      if (connectionLayer.empty()) {
        g.append('g').attr('class', 'connection-layer');
      }
      // const labelLayer = g.append('g').attr('class', 'label-layer') // No longer needed

      // Store node layer reference
      nodeLayerRef.current = mainNodeLayer.node() as SVGGElement;

      // Note: Grid creation moved to separate useEffect to prevent disappearing during drag

      // Zoom behavior
      const zoom = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.4, 4])
        .on('zoom', (event) => {
          const transform = event.transform;
          const prevK = currentTransformRef.current.k;

          // Resolve current canvas root every time to avoid stale selection when layers are re-created
          if (svgRef.current) {
            const rootSel = d3.select(svgRef.current).select<SVGGElement>('g.canvas-root');
            if (!rootSel.empty()) {
              rootSel.attr('transform', transform.toString());
            }
          }
          if (onZoomLevelChange && prevK !== transform.k) {
            onZoomLevelChange(transform.k);
          }

          // Grid updates are handled by the dedicated grid effect reacting to canvasTransform

          onTransformChange?.(transform);

          // Keep connection preview endpoint pinned to cursor during canvas pan/zoom
          // This ensures the preview path updates visually while dragging the canvas
          if (isConnecting && connectionStart && svgRef.current) {
            const srcEvt: any = event.sourceEvent;
            if (srcEvt) {
              // Compute cursor position relative to canvas coordinates using current zoom transform
              const [screenX, screenY] = d3.pointer(srcEvt, svgRef.current as any);
              const [canvasX, canvasY] = transform.invert([screenX, screenY]);
              onPortDrag(canvasX, canvasY);
            }
          }

          // Force nodes to re-render on zoom change by updating their visual state
          if (Math.abs(transform.k - prevK) > 0.01) {
            mainNodeLayer.selectAll('.node').each(function (this: any, d: any) {
              const node = d3.select(this);
              // Force update by re-applying transform
              node.attr('transform', `translate(${d.x}, ${d.y})`);
            });
          }

          // Update ref after consumers have used previous value for comparisons
          currentTransformRef.current = transform;
        });

      // Bind zoom only once (skip if already initialized) and register behavior once
      if (svg.attr('data-zoom-init') !== 'true') {
        svg.call(zoom);
        svg.attr('data-zoom-init', 'true');
        onRegisterZoomBehavior?.(zoom);
      }

      // Set initial transform (not in dependencies to avoid infinite loop)
      svg.call(
        zoom.transform,
        d3.zoomIdentity.translate(canvasTransform.x, canvasTransform.y).scale(canvasTransform.k)
      );

      // Optimized drag functions
      // Concise wrapper for creating standard port drag callbacks with shared params
      const makePortDragHandlers = (opts?: { logTag?: string; requireTargetOnEnd?: boolean }) =>
        createPortDragCallbacks({
          startAsType: 'output',
          onPortDragStart,
          onPortDrag,
          onPortDragEnd,
          nodes,
          getCapturedStart: () => dragConnectionDataRef.current,
          setCapturedStart: (
            v: { nodeId: string; portId: string; type: 'input' | 'output' } | null
          ) => {
            dragConnectionDataRef.current = v as any;
          },
          getHitTestPortRadius,
          ...opts,
        });

      // Local drag handlers removed (extracted to utils/node-drag)

      // Connections are rendered in the dedicated connections-only effect.
      // Connection preview is also handled in the connection state effect.

      // Render nodes via core function
      const dragBehavior = createNodeDragBehavior({
        svgRef,
        isConnectingRef,
        dragConnectionDataRef,
        batchedConnectionUpdateRef,
        batchedVisualUpdateRef,
        clearAllDragPositions,
        clearAllDragTracking,
        currentDragPositionsRef,
        connectionUpdateQueueRef,
        visualUpdateQueueRef,
        startDragging,
        updateDragPosition,
        endDragging,
        getDraggedNodeId,
        isContextDragging,
        getCachedSelection: (type) => getCachedSelection(type),
        clearConnCache,
        updateConnDragPos,
        connections,
        getConnectionPath,
        updateDraggedNodePositionCallback,
        resetNodeVisualStyleCallback,
        zIndexManager,
        nodePositionCacheRef,
        rafScheduler,
        onNodeDrag,
        onNodeClick,
        setDraggedElementRef: (sel) => {
          draggedElementRef.current = sel;
        },
      });

      const { nodeEnter, nodeGroups } = createNodeGroups<WorkflowNode>(
        mainNodeLayer as unknown as d3.Selection<SVGGElement, unknown, SVGGElement, unknown>,
        virtualizedWorkflow.levelOfDetail.nodes,
        {
          getId: (d) => d.id,
          getTransform: (d) => `translate(${d.x}, ${d.y})`,
          cursor: 'move',
          onExit: (d) => {
            allNodeElementsRef.current.delete(d.id);
          },
          onEnterEach: (d, el) => {
            // Register node element in our centralized management
            allNodeElementsRef.current.set(d.id, el);
            if (isDragging && draggedNodeId === d.id) {
              const nodeElement = d3.select(el);
              nodeElement.classed('dragging', true);
              draggedElementRef.current = nodeElement;
            }
          },
          dragBehavior,
        }
      );

      // Create baseline node children elements once (and ensure for merged nodes)
      createNodeElements(nodeEnter as any, nodeGroups as any);

      // Ensure node background path (shape) is computed and applied
      updateNodeBackgroundPath(nodeGroups as any, {
        designerMode: workflowContextState.designerMode as any,
        getConfigurableDimensions: getConfigurableDimensions as any,
        getNodeShape: getNodeShape as any,
        getNodeShapePath: (d: any, radius: any) => getNodeShapePath(d, radius),
      });

      // Restore node background interactions (click, dblclick, dragover/drop)
      attachNodeBackgroundEvents(nodeEnter as any, {
        isDragging: isContextDragging(),
        isConnecting: isConnectingRef.current,
        canDropOnNode: _canDropOnNodeProp ?? undefined,
        onNodeClick: (node, multi) => onNodeClick(node, multi),
        onNodeDoubleClick: (node) => _onNodeDoubleClick?.(node),
        setDropFeedback: () => {},
        workflowContextState: { designerMode: workflowContextState.designerMode as any },
        connections,
        connectionStart: connectionStartRef.current as any,
        onPortDragEnd: (targetNodeId?: string, targetPortId?: string) => {
          onPortDragEnd(targetNodeId, targetPortId);
        },
      });

      // Enhanced: Immediately preserve dragging state after merge operation
      // This must happen before any other node operations to prevent class removal
      nodeGroups.each(function (d: any) {
        const nodeElement = d3.select(this);
        const currentDraggedNodeId = getDraggedNodeId();
        const isCurrentlyDragging = isContextDragging();

        if (isCurrentlyDragging && currentDraggedNodeId === d.id) {
          // Force apply dragging class immediately after merge
          nodeElement.classed('dragging', true);
          // Ensure draggedElementRef points to the correct merged element
          if (draggedElementRef.current === null || draggedElementRef.current.node() !== this) {
            draggedElementRef.current = nodeElement;
          }
        }
      });

      // REMOVED: JavaScript hover events for port visibility
      // CSS now handles all port visibility states via classes:
      // - .canvas-container.architecture-mode .port-group (hidden by default)
      // - .canvas-container.architecture-mode .node:hover .port-group (visible on hover)
      // - .canvas-container .workflow-canvas.connecting .port-group (visible when connecting)
      // This prevents inline style conflicts with CSS classes

      // Update node background stroke width based on drag state
      nodeGroups.select('.node-background').attr('stroke-width', (d: any) => {
        // CRITICAL: Skip stroke width update for actively dragged node
        const currentDraggedNodeId = getDraggedNodeId();
        const isCurrentlyDragging = isContextDragging();

        if (isCurrentlyDragging && currentDraggedNodeId === d.id) {
          // Return thicker width for dragged node
          return 3;
        }

        return 2;
      });

      // Update architecture outline box to slightly exceed node bounds with per-type customization
      updateArchOutline(nodeGroups as any, {
        isArchMode: workflowContextState.designerMode === 'architecture',
        getNodeTypeInfo,
        getConfigurableDimensions,
      });

      // Apply visual styling to all nodes using centralized system with improved stability
      applyNodeVisualState(nodeGroups as any, {
        isNodeSelected,
        getDraggedNodeId,
        isContextDragging,
        getNodeColor,
      });

      // Mark as initialized and organize z-index
      if (!isInitialized) {
        setIsInitialized(true);
        // Initial z-index organization - use immediate execution for initial setup
        setTimeout(() => {
          if (!isDragging) {
            zIndexManager.organizeNodeZIndexImmediate(); // immediate initialization
          }
        }, 0);
      }

      // Node icon containers are created in createNodeElements

      updateIconsAndLabels(nodeGroups as any, defs, {
        designerMode: workflowContextState.designerMode as any,
        getConfigurableDimensions,
        NodeTypes,
        getNodeIcon,
        renderIconUse,
        renderConfig: virtualizedWorkflow.levelOfDetail.renderConfig,
      });

      // Render ports with level-of-detail optimization
      const showPorts = virtualizedWorkflow.levelOfDetail.renderConfig.showPorts;

      // Input ports (extracted helper)
      renderInputPorts(nodeGroups as any, {
        showPorts,
        getConfigurableDimensions: getConfigurableDimensions as any,
        getConfigurablePortPositions: getConfigurablePortPositions as any,
        canDropOnPort,
        getIsConnectingActive: () => Boolean(isConnectingRef.current && connectionStartRef.current),
        getConnectionStart: () => connectionStartRef.current as any,
        onPortDragEnd: (tNodeId, tPortId, cx, cy) => onPortDragEndProp?.(tNodeId, tPortId, cx, cy),
        clearConnectionState: () => dispatch?.({ type: 'CLEAR_CONNECTION_STATE' }),
        announce,
        setKeyboardConnecting: (v) => {
          keyboardConnectingRef.current = v;
        },
      });

      // Input port capacity indicators removed

      // Output ports (extracted helper)
      renderOutputPorts(nodeGroups as any, {
        showPorts,
        connections,
        nodeVariant,
        onPortClick,
        announce,
        getConfigurableDimensions: getConfigurableDimensions as any,
        getConfigurablePortPositions: getConfigurablePortPositions as any,
        getIsConnectingActive: () => Boolean(isConnectingRef.current),
        hasLocalDragConnection: () => Boolean(dragConnectionDataRef.current),
        setLocalDragConnection: (v) => {
          dragConnectionDataRef.current = v as any;
        },
        dispatch,
        makePortDragHandlers,
      });

      // Architecture mode: four side ports (top/right/bottom/left) as virtual ports
      const isArchitectureMode = workflowContextState.designerMode === 'architecture';
      renderSidePorts(nodeGroups as any, {
        isArchitectureMode,
        showPorts,
        connections,
        getConfigurableDimensions: getConfigurableDimensions as any,
        nodeVariant,
        modeId: workflowContextState.designerMode as any,
        onPortClick,
        makePortDragHandlers,
      });

      // Bottom ports - สำหรับ AI Agent nodes ที่มี bottomPorts
      renderBottomPorts(nodeGroups as any, {
        showPorts,
        connections,
        nodeVariant,
        isConnecting,
        connectionStart,
        canDropOnPort,
        isNodeSelected,
        nodeMap,
        modeId: workflowContextState.designerMode as any,
        getConfigurableDimensions: getConfigurableDimensions as any,
        onPortDragStart,
        onPortDrag,
        onPortDragEnd,
        getHitTestPortRadius,
        canBottomPortAcceptConnection: (nodeId, portId, conns, map, modeId) =>
          canBottomPortAcceptConnection(nodeId, portId, conns, map, modeId as any),
        resolveDragEndTarget,
        nodes,
        dbg,
      });

      // Canvas event handlers
      svg.on('click', () => {
        onCanvasClick();
      });

      svg.on('mousemove', (event) => {
        const [x, y] = d3.pointer(event, svg.node());
        const transform = d3.zoomTransform(svg.node() as any);
        const [canvasX, canvasY] = transform.invert([x, y]);
        onCanvasMouseMove(canvasX, canvasY);
      });

      // Initialize or refresh roving tabindex on all port groups after rendering
      if (svgRef.current) {
        const svgSelForRoving = d3.select(svgRef.current);
        setupRovingTabIndex(svgSelForRoving);
        attachRovingHandlers(svgSelForRoving);
      }

      // Enhanced cleanup function with dragging state management
      return () => {
        // Cancel any pending animations handled by local batching refs only

        // Clear any pending dragging state cleanup
        if (dragStateCleanupRef.current) {
          clearTimeout(dragStateCleanupRef.current);
          dragStateCleanupRef.current = null;
        }

        // Note: keep dragging class for selective removal below

        // Only reset dragging state if component is actually unmounting
        // Check if we're in middle of a drag operation - if so, preserve state
        const currentlyDragging = isContextDragging();
        if (!currentlyDragging) {
          // Reset all dragging state references only when not actively dragging
          endDragging();
        }

        draggedElementRef.current = null;
        draggedNodeElementRef.current = null;

        // Selective cleanup: preserve canvas structure (defs, canvas-root, zoom/pan)
        if (currentSvgRef) {
          const svgSel = d3.select(currentSvgRef);

          // Find currently dragging nodes and collect their ids
          const draggingSel = svgSel
            .select('g.node-layer')
            .selectAll<SVGGElement, any>('.node.dragging');
          const draggingIds = new Set<string>();
          const draggingNodes = draggingSel.nodes();
          draggingNodes.forEach((el) => {
            const bound = d3.select(el).datum() as any;
            const id = bound?.id ?? el.getAttribute('data-node-id') ?? undefined;
            if (id) {
              draggingIds.add(String(id));
            }
          });

          // Also remove any connections associated with those nodes from the connection layer
          if (draggingIds.size > 0) {
            const connSel = svgSel
              .select('g.connection-layer')
              .selectAll<SVGGElement, any>('.connection');
            connSel
              .filter(
                (c: any) =>
                  !!c && (draggingIds.has(c.sourceNodeId) || draggingIds.has(c.targetNodeId))
              )
              .remove();
          }

          // Remove only the currently dragging nodes to avoid full layer churn
          draggingSel.remove();

          // Note: Keep <defs> and <g.canvas-root> to avoid losing markers and zoom/pan state
        }
        // Clear connection path cache managed by hook
        clearConnCache();
        gridCacheRef.current = null;
        // Do not clear allNodeElements here; entries are pruned via onExit and preserved across merges
      };
    } catch (error) {
      console.error('Error in main D3 rendering effect:', error);
      // Reset caches on error to prevent further issues
      clearConnCache();
      if (gridCacheRef.current) {
        gridCacheRef.current = null;
      }
      if (allNodeElementsRef.current) {
        allNodeElementsRef.current.clear();
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, nodeVariant]); // Nodes-focused; connections are updated in a separate effect

  // Connections-only effect: delegate to centralized renderer
  useEffect(() => {
    if (!svgRef.current) {
      return;
    }
    try {
      const svg = d3.select(svgRef.current);
      // Precompute grouping once for architecture mode
      const buildArchGrouping = () => {
        const nodesList = Array.from(nodeMap.values());
        const buckets = groupConnectionsBySideAndPort(connections, nodesList, 'architecture');
        const indexMap = new Map<string, { index: number; total: number }>();
        const primaryIds: string[] = [];
        for (const bucket of buckets.values()) {
          const total = bucket.items.length;
          for (let i = 0; i < total; i += 1) {
            const item = bucket.items[i];
            indexMap.set(item.id, { index: i, total });
          }
          if (total > 0) {
            primaryIds.push(bucket.items[0].id);
          }
        }
        return { indexMap, primaryIds };
      };

      // In architecture mode, render only a single representative connection per group
      const resolveConnectionsToRender = (): Connection[] => {
        if (workflowContextState.designerMode !== 'architecture') {
          return connections;
        }
        const { primaryIds } = buildArchGrouping();
        const byId = new Map(connections.map((c) => [c.id, c] as const));
        const reps: Connection[] = [];
        for (const id of primaryIds) {
          const conn = byId.get(id);
          if (conn) {
            reps.push(conn);
          }
        }
        return reps;
      };

      const archGroupMap =
        workflowContextState.designerMode === 'architecture' ? buildArchGrouping().indexMap : null;

      const getGroupInfoForMode = (
        id: string,
        list: Connection[],
        mode: DesignerMode
      ): { index: number; total: number; isMultiple: boolean } => {
        const resolvedMode = mode || 'workflow';
        if (resolvedMode === 'architecture' && archGroupMap) {
          const info = archGroupMap.get(id);
          if (info) {
            return { index: info.index, total: info.total, isMultiple: info.total > 1 };
          }
          return { index: 0, total: 1, isMultiple: false };
        }
        return getConnectionGroupInfo(id, list);
      };

      const connectionsToRender = resolveConnectionsToRender();

      renderConnectionsLayer({
        svg,
        connections: connectionsToRender,
        onConnectionClick,
        // Use cached paths for render pass; live drag geometry is handled by RAF batch updater
        getConnectionPath: (c) => getConnectionPath(c),
        createFilledPolygonFromPath: createFilledPolygonFromPathCallback,
        getConnectionMarker,
        getConnectionGroupInfo: (id, list) =>
          getGroupInfoForMode(id, list, workflowContextState.designerMode as DesignerMode),
        workflowMode: workflowContextState.designerMode as DesignerMode,
        nodeMap,
      });
    } catch (e) {
      console.error('Connection effect error:', e);
    }
  }, [
    connections,
    getConnectionPath,
    workflowContextState.designerMode,
    nodeMap,
    onConnectionClick,
    createFilledPolygonFromPathCallback,
    getConnectionMarker,
    svgRef,
  ]);

  // Bind root SVG events in a tiny effect to avoid stale closures
  useEffect(() => {
    if (!svgRef.current) {
      return;
    }
    const svg = d3.select(svgRef.current);
    svg.on('click.canvas', () => onCanvasClick());
    svg.on('mousemove.canvas', (event) => {
      const [x, y] = d3.pointer(event, svg.node());
      const transform = d3.zoomTransform(svg.node() as any);
      const [canvasX, canvasY] = transform.invert([x, y]);
      onCanvasMouseMove(canvasX, canvasY);
    });
    return () => {
      svg.on('click.canvas', null).on('mousemove.canvas', null);
    };
  }, [onCanvasClick, onCanvasMouseMove, svgRef]);

  // 🎯 ISOLATED GRID EFFECT - Completely separate grid management with cache protection
  useEffect(() => {
    // Only recreate grid when absolutely necessary to maximize cache hits
    if (!svgRef.current || !isInitialized || !showGrid) {
      return;
    }

    try {
      const svg = d3.select(svgRef.current);
      const gridLayer = svg.select('.grid-layer');

      if (gridLayer.empty()) {
        return;
      }

      // Get current canvas dimensions
      const rect = svgRef.current.getBoundingClientRect();

      // CRITICAL: Don't clear existing grid - let createGrid handle cache validation
      // This prevents unnecessary grid clearing that reduces cache hit rate
      const gridLayerElement = gridLayer.node();
      if (gridLayerElement) {
        const typedGridLayer = d3.select(gridLayerElement as SVGGElement);
        createGridCallback(typedGridLayer, canvasTransform, rect.width, rect.height);
      }
    } catch (error) {
      console.error('Error in grid rendering effect:', error);
      // Reset grid cache on error
      if (gridCacheRef.current) {
        gridCacheRef.current = null;
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGrid, canvasTransform.x, canvasTransform.y, canvasTransform.k, isInitialized]); // Don't include createGrid to prevent loops

  // Remove duplicate CSS since hover styles are already in globals.css

  // Visual state effect - handle selection and connection states with z-index management
  useEffect(() => {
    if (!svgRef.current || !isInitialized) {
      return;
    }

    const svg = d3.select(svgRef.current);
    const mainNodeLayer = svg.select('.node-layer');
    const connectionLayer = svg.select('.connection-layer');

    // Update node visual states only
    mainNodeLayer.selectAll('.node').each(function (d: any) {
      const nodeElement = d3.select(this);
      const isSelected = isNodeSelected(d.id);
      const isDragging = nodeElement.classed('dragging');
      const nodeBackground = nodeElement.select('.node-background');

      nodeElement.classed('selected', isSelected);

      if (!isDragging) {
        if (isSelected) {
          nodeElement.style('filter', 'drop-shadow(0 0 8px rgba(33, 150, 243, 0.5))');
          nodeBackground.attr('stroke', '#2196F3').attr('stroke-width', 3);
        } else {
          nodeElement.style('filter', 'none');
          nodeBackground.attr('stroke', getNodeColor(d.type, d.status)).attr('stroke-width', 2);
        }
      }
    });

    // Ensure proper z-index after visual state changes (but only if not dragging)
    if (!isDragging) {
      zIndexManager.organizeNodeZIndexImmediate(); // immediate layering
    }

    // Update connection selection state only - don't touch hover state
    connectionLayer.selectAll('.connection').each(function (d: any) {
      const connectionGroup = d3.select(this as SVGGElement);
      const pathElement = connectionGroup.select('.connection-path');
      const isSelected = selectedConnection?.id === d.id;
      const isCurrentlyHovered = connectionGroup.classed('connection-hover');

      // Update selection class
      connectionGroup.classed('connection-selected', isSelected);

      // Production selection effects removed - using CSS-based styling

      // Only update visual attributes if not currently hovered
      if (!isCurrentlyHovered) {
        if (isSelected) {
          pathElement
            .attr('stroke', '#2196F3')
            .attr('stroke-width', 3)
            .attr('marker-end', getConnectionMarker(d, 'selected'));
        } else {
          pathElement
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .attr('marker-end', getConnectionMarker(d, 'default'));
        }
      }
    });
  }, [
    selectedNodes,
    selectedConnection?.id,
    isInitialized,
    isDragging,
    getConnectionMarker,
    isNodeSelected,
    organizeNodeZIndex,
    zIndexManager,
    svgRef,
  ]);

  // Connection state effect
  useEffect(() => {
    if (!svgRef.current || !isInitialized) {
      return;
    }

    const svg = d3.select(svgRef.current);
    // Always operate on the main canvas root / connection layer
    const canvasRoot = svg.select<SVGGElement>('g.canvas-root');
    if (canvasRoot.empty()) {
      return;
    }
    const connectionLayer = canvasRoot.select<SVGGElement>('g.connection-layer');
    const targetLayer = connectionLayer.empty() ? canvasRoot : connectionLayer;

    // Handle connection preview via helper
    targetLayer.selectAll('.connection-preview').remove();
    renderConnectionPreviewPath(targetLayer, {
      isConnecting,
      connectionStart,
      connectionPreview,
      nodes,
      nodeMap,
      nodeVariant,
      modeId: workflowContextState.designerMode as DesignerMode,
      getDims: getConfigurableDimensions as any,
      getArrowMarkerForMode,
      dbg,
    });

    // Architecture mode: temporarily tag side-ports as input/output groups during connection
    tagSidePortsDuringConnection(svg, {
      modeId: workflowContextState.designerMode as DesignerMode,
      isConnecting,
      connectionStart,
    });

    // Update port visual states during connection via helper

    updatePortsVisualState(svg, {
      isConnecting,
      connectionStart,
      canDropOnPort,
      modeId: workflowContextState.designerMode as DesignerMode,
      getDims: getConfigurableDimensions as any,
      updatePortHighlighting,
    });

    // Fixed: Added all required dependencies to prevent stale closures
    // Uses memoized functions where possible to prevent infinite re-renders
  }, [
    isConnecting,
    connectionPreview,
    connectionStart,
    nodeVariant,
    isInitialized,
    workflowContextState.designerMode,
    nodeMap,
    nodes,
    canDropOnPort,
    getConfigurableDimensions,
    getArrowMarkerForMode,
    updatePortHighlighting,
    svgRef,
    dbg,
  ]);

  // Connection cleanup effect - clear port highlighting when connection ends
  useEffect(() => {
    if (!svgRef.current || !isInitialized) {
      return;
    }

    // Clear all port highlighting when connection ends
    if (!isConnecting) {
      const svg = d3.select(svgRef.current);

      // Remove can-dropped class from all port groups
      svg.selectAll('.input-port-group').classed('can-dropped', false);
      svg.selectAll('.output-port-group').classed('can-dropped', false);
      svg.selectAll('.port-group').classed('can-dropped', false);

      // Note: This is an expected, noise-only event; avoid warn-level logging to prevent React DevTools
      // from printing a component stack for non-issues.
      // (Intentionally silenced)
    }
  }, [isConnecting, isInitialized, svgRef, dbg]);

  // Global ESC to cancel current connection gesture quickly
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isConnectingRef.current || dragConnectionDataRef.current) {
          // Clear preview and connection state via dispatch path
          dragConnectionDataRef.current = null;
          if (onPortDragEndProp) {
            onPortDragEndProp(undefined, undefined, undefined, undefined);
          } else {
            dispatch?.({ type: 'CLEAR_CONNECTION_STATE' });
          }
          e.stopPropagation();
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as any);
  }, [dispatch, onPortDragEndProp]);

  // Canvas state effect
  useEffect(() => {
    if (!svgRef.current || !isInitialized) {
      return;
    }

    const svg = d3.select(svgRef.current);
    const gridLayer = svg.select('.grid-layer');

    // Update grid and toolbar
    const rect = svgRef.current.getBoundingClientRect();
    createGridCallback(gridLayer as any, canvasTransform, rect.width, rect.height);
  }, [canvasTransform, isInitialized, createGridCallback, svgRef]);

  // Cleanup effect
  useEffect(() => {
    return () => {
      // rafScheduler manages its own rAF lifecycle
      // Clear connection path cache managed by hook
      clearConnCache();
      gridCacheRef.current = null;
    };
  }, [clearConnCache]);

  return null; // This component only manages D3 rendering
}

export default WorkflowCanvas;
