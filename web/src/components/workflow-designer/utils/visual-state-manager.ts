/**
 * Visual State Manager
 * Handles batched visual updates, drag positioning, and node styling for performance optimization
 */

import * as d3 from 'd3'
import type { WorkflowNode, Connection } from '../types'
import { getNodeColor } from './node-utils'

// D3 selection type aliases to avoid 'any' usage
type LayerSelection = d3.Selection<SVGGElement, unknown, null, undefined>
type NodeElementSelection = d3.Selection<SVGGElement, unknown, null, undefined>

// Drag smoothing and gating configuration
const SMOOTHING_ALPHA = 0.5 // 0..1 (higher = follow cursor more closely)
const MOVEMENT_THRESHOLD_PX = 2 // skip connection path recompute if movement is below this distance
const MOVEMENT_THRESHOLD_SQ = MOVEMENT_THRESHOLD_PX * MOVEMENT_THRESHOLD_PX

// Keep track of the last position used to trigger a connection-path update per node (for spatial gating)
const lastConnUpdatePos: Map<string, { x: number; y: number }> = new Map()

// Adaptive performance configuration interfaces
interface AdaptiveConfig {
    vBudget: number
    lastDuration: number
}

interface ConnectionAdaptiveConfig {
    cBudget: number
    lastDuration: number
}

// Window globals for adaptive performance
declare global {
    interface Window {
        __wfAdaptive?: AdaptiveConfig
        __wfConnAdaptive?: ConnectionAdaptiveConfig
    }
}

// Configuration objects for complex functions
export interface DragPositionConfig {
    draggedElement: NodeElementSelection | null
    currentDragPositions: Map<string, { x: number; y: number }>
    updateConnDragPos: (nodeId: string, pos: { x: number; y: number }) => void
    nodeConnectionsMap: Map<string, Connection[]>
    connectionUpdateQueue: Set<string>
    lastDragUpdate: { current: number }
    dragUpdateThrottle: number
    startBatchedConnectionUpdates: () => void
}

export interface VisualCacheConfig {
    nodePositionCache: Map<string, { x: number; y: number }>
    currentDragPositions: Map<string, { x: number; y: number }>
    connectionUpdateQueue: Set<string>
    visualUpdateQueue: Set<string>
    clearConnCache: () => void
    clearAllDragPositions: () => void
    zIndexManager: { clearState: () => void }
    rafScheduler: { clear: () => void }
    batchedConnectionUpdateRef: React.MutableRefObject<number | null>
    batchedVisualUpdateRef: React.MutableRefObject<number | null>
}

/**
 * Processes batched visual updates for nodes with adaptive performance management
 */
export function processBatchedVisualUpdates(
    visualUpdateQueue: Set<string>,
    allNodeElements: Map<string, SVGGElement>,
    onComplete: () => void
): boolean {
    if (visualUpdateQueue.size === 0) {
        return false
    }

    const start = performance.now()

    // Initialize adaptive config if not present (using nullish coalescing)
    window.__wfAdaptive ??= { vBudget: 4, lastDuration: 0 }

    const adaptive = window.__wfAdaptive
    const MAX_MS = adaptive.vBudget

    for (const nodeId of Array.from(visualUpdateQueue)) {
        if (performance.now() - start > MAX_MS) {
            break
        }

        const element = allNodeElements.get(nodeId)
        if (!element) {
            visualUpdateQueue.delete(nodeId)
            continue
        }

        const nodeElement = d3.select(element)
        const nodeBackground = nodeElement.select('.node-background')

        nodeElement
            .style('opacity', 0.9)
            .style('filter', 'drop-shadow(0 6px 12px rgba(0, 0, 0, 0.3))')

        nodeBackground
            .attr('stroke', '#2196F3')
            .attr('stroke-width', 3)

        visualUpdateQueue.delete(nodeId)
    }

    // Update adaptive performance config
    const duration = performance.now() - start
    adaptive.lastDuration = duration
    const usage = duration / MAX_MS

    if (usage < 0.6 && adaptive.vBudget < 6) {
        adaptive.vBudget += 0.25
    } else if (usage > 0.9 && adaptive.vBudget > 2) {
        adaptive.vBudget -= 0.25
    }

    // Return true if more processing needed
    const hasMore = visualUpdateQueue.size > 0
    if (!hasMore) {
        onComplete()
    }

    return hasMore
}

/**
 * Processes batched connection updates with adaptive performance management
 */
export function processBatchedConnectionUpdates(
    connectionUpdateQueue: Set<string>,
    nodeConnectionsMap: Map<string, Connection[]>,
    connectionLayer: LayerSelection,
    getConnectionPath: (conn: Connection, useDragPositions?: boolean) => string,
    onComplete: () => void
): boolean {
    if (connectionUpdateQueue.size === 0) {
        return false
    }

    // PERFORMANCE: Use cached DOM selections to avoid repeated queries
    if (!connectionLayer) {
        return false
    }

    // PERFORMANCE: Optimized batching - process more items but with time slicing
    const nodesToProcess = Array.from(connectionUpdateQueue)
    const startTime = performance.now()

    // Initialize adaptive config if not present (using nullish coalescing)
    window.__wfConnAdaptive ??= { cBudget: 8, lastDuration: 0 }

    const connAdaptive = window.__wfConnAdaptive
    const maxProcessingTime = connAdaptive.cBudget

    for (const nodeId of nodesToProcess) {
        // Time-slice processing to avoid blocking main thread
        if (performance.now() - startTime > maxProcessingTime) {
            break
        }

        const affectedConnections = nodeConnectionsMap.get(nodeId) || []
        if (affectedConnections.length === 0) {
            connectionUpdateQueue.delete(nodeId)
            continue
        }

        // PERFORMANCE: Batch DOM operations together
        const connectionElements = affectedConnections
            .map((conn) => ({
                conn,
                element: connectionLayer.select(`[data-connection-id="${conn.id}"]`),
            }))
            .filter(({ element }) => !element.empty())

        // Update all paths in a single batch (no-op if path unchanged)
        connectionElements.forEach(({ conn, element }) => {
            const pathElement = element.select('.connection-path')
            // CRITICAL FIX: Only use drag positions if this connection involves the currently dragged node
            // This prevents using stale drag positions from previous drag operations
            const shouldUseDragPositions = nodeId === conn.sourceNodeId || nodeId === conn.targetNodeId
            const newPath = getConnectionPath(conn, shouldUseDragPositions)
            const oldPath = pathElement.attr('d')
            if (oldPath !== newPath) {
                pathElement.attr('d', newPath)
            }
        })

        connectionUpdateQueue.delete(nodeId)
    }

    // Update adaptive performance config
    const duration = performance.now() - startTime
    connAdaptive.lastDuration = duration
    const usage = duration / maxProcessingTime

    if (usage < 0.55 && connAdaptive.cBudget < 10) {
        connAdaptive.cBudget += 0.5
    } else if (usage > 0.9 && connAdaptive.cBudget > 4) {
        connAdaptive.cBudget -= 0.5
    }

    // Return true if more processing needed
    const hasMore = connectionUpdateQueue.size > 0
    if (!hasMore) {
        onComplete()
    }

    return hasMore
}

/**
 * Updates dragged node position with immediate visual feedback and batched connection updates
 */
export function updateDraggedNodePosition(
    nodeId: string,
    newX: number,
    newY: number,
    config: DragPositionConfig
): void {
    // CRITICAL FIX: Get previous position for smoothing, but validate it's from current drag session
    let prev = config.currentDragPositions.get(nodeId)

    // If no previous position or position is too far (indicating a new drag or stale data), start fresh
    if (!prev) {
        prev = { x: newX, y: newY }
    } else {
        // Check if this is likely a stale position from a previous drag session
        const distSq = (prev.x - newX) * (prev.x - newX) + (prev.y - newY) * (prev.y - newY)
        if (distSq > 10000) { // More than 100px away, likely stale from previous drag
            prev = { x: newX, y: newY }
        }
    }

    const smoothedX = prev.x + (newX - prev.x) * SMOOTHING_ALPHA
    const smoothedY = prev.y + (newY - prev.y) * SMOOTHING_ALPHA

    // Always update node position immediately for smooth dragging (using smoothed coordinates)
    if (config.draggedElement) {
        config.draggedElement.attr('transform', `translate(${smoothedX}, ${smoothedY})`)
    }

    // Store current smoothed drag position
    const smoothed = { x: smoothedX, y: smoothedY }
    config.currentDragPositions.set(nodeId, smoothed)
    // Sync with connection paths hook for live path updates during drag (use smoothed to prevent jitter)
    config.updateConnDragPos(nodeId, smoothed)

    // Spatial threshold gating: only recompute connection paths if movement from the last recompute exceeds threshold
    const lastForConn = lastConnUpdatePos.get(nodeId)
    if (lastForConn) {
        const dx = smoothedX - lastForConn.x
        const dy = smoothedY - lastForConn.y
        if (dx * dx + dy * dy < MOVEMENT_THRESHOLD_SQ) {
            return
        }
    }

    // Time-based throttle to improve performance (reduced throttle for more responsive updates)
    const now = Date.now()
    if (now - config.lastDragUpdate.current < Math.min(config.dragUpdateThrottle, 16)) { // Max 60fps
        return
    }
    config.lastDragUpdate.current = now

    // Queue connection updates for batched processing
    const affectedConnections = config.nodeConnectionsMap.get(nodeId) || []
    if (affectedConnections.length > 0) {
        config.connectionUpdateQueue.add(nodeId)
        lastConnUpdatePos.set(nodeId, smoothed)
        config.startBatchedConnectionUpdates()
    }
}

/**
 * Clears drag position tracking for a specific node
 */
export function clearNodeDragTracking(nodeId: string): void {
    lastConnUpdatePos.delete(nodeId)
    // Also clear from window adaptive configs to prevent stale state
    if (window.__wfAdaptive) {
        window.__wfAdaptive.lastDuration = 0
    }
    if (window.__wfConnAdaptive) {
        window.__wfConnAdaptive.lastDuration = 0
    }
}

/**
 * CRITICAL: Immediate connection sync after node position commit
 * Forces immediate connection path updates using committed positions to prevent flicker
 */
export function syncConnectionsWithCommittedPositions(
    nodeId: string,
    nodeConnectionsMap: Map<string, Connection[]>,
    connectionLayer: LayerSelection,
    getConnectionPath: (conn: Connection, useDragPositions?: boolean) => string,
    clearConnCache: () => void
): void {
    if (!connectionLayer) {
        return
    }

    // Clear cache first to force regeneration with committed positions
    clearConnCache()

    const affectedConnections = nodeConnectionsMap.get(nodeId) || []
    if (affectedConnections.length === 0) {
        return
    }

    // Immediately update all affected connections with committed positions (no drag override)
    affectedConnections.forEach((conn) => {
        const connectionElement = connectionLayer.select(`[data-connection-id="${conn.id}"]`)
        if (connectionElement.empty()) {
            return
        }

        const pathElement = connectionElement.select('.connection-path')
        // Use committed positions only (useDragPositions = false)
        const newPath = getConnectionPath(conn, false)
        pathElement.attr('d', newPath)
    })
}

/**
 * ENHANCED: Complete state synchronization after any node drop
 * Ensures all caches are cleared and all connections use current committed positions
 * This is the most comprehensive sync function to prevent any stale state issues
 */
export function forceCompleteStateSyncAfterDrop(
    _droppedNodeId: string, // For logging/debugging purposes
    allConnections: Connection[],
    connectionLayer: LayerSelection,
    getConnectionPath: (conn: Connection, useDragPositions?: boolean) => string,
    clearConnCache: () => void,
    clearAllDragPositions: () => void,
    additionalCacheCleanup?: () => void
): void {
    if (!connectionLayer) {
        return
    }

    // STEP 1: Clear ALL caches and drag state completely
    clearConnCache() // Connection path cache
    clearAllDragPositions() // Drag position tracking
    clearAllDragTracking() // Visual state manager tracking
    lastConnUpdatePos.clear() // Local connection update tracking

    // STEP 2: Additional cleanup if provided (e.g., z-index, RAF, etc.)
    if (additionalCacheCleanup) {
        additionalCacheCleanup()
    }

    // STEP 3: Force regeneration of ALL connection paths with committed positions
    // This ensures no connection retains any stale state from the drag operation
    allConnections.forEach((conn) => {
        const connectionElement = connectionLayer.select(`[data-connection-id="${conn.id}"]`)
        if (connectionElement.empty()) {
            return
        }

        const pathElement = connectionElement.select('.connection-path')
        // CRITICAL: Use committed positions only (useDragPositions = false) for ALL connections
        const newPath = getConnectionPath(conn, false)
        const currentPath = pathElement.attr('d')

        // Only update if path actually changed to avoid unnecessary DOM manipulation
        if (currentPath !== newPath) {
            pathElement.attr('d', newPath)
        }
    })

    // STEP 4: Reset all adaptive performance configs to prevent stale optimization state
    if (window.__wfAdaptive) {
        window.__wfAdaptive.lastDuration = 0
        window.__wfAdaptive.vBudget = 4 // Reset to default
    }
    if (window.__wfConnAdaptive) {
        window.__wfConnAdaptive.lastDuration = 0
        window.__wfConnAdaptive.cBudget = 8 // Reset to default
    }
}

/**
 * Clears all drag position tracking
 */
export function clearAllDragTracking(): void {
    lastConnUpdatePos.clear()
    // Reset adaptive configs to prevent performance issues from stale state
    if (window.__wfAdaptive) {
        window.__wfAdaptive.lastDuration = 0
        window.__wfAdaptive.vBudget = 4 // Reset to default
    }
    if (window.__wfConnAdaptive) {
        window.__wfConnAdaptive.lastDuration = 0
        window.__wfConnAdaptive.cBudget = 8 // Reset to default
    }
}

/**
 * Resets node visual style based on selection state
 */
export function resetNodeVisualStyle(
    nodeElement: NodeElementSelection,
    nodeId: string,
    isNodeSelected: (nodeId: string) => boolean,
    nodeMap: Map<string, WorkflowNode>
): void {
    const isSelected = isNodeSelected(nodeId)
    const nodeBackground = nodeElement.select('.node-background')
    const node = nodeMap.get(nodeId)

    if (isSelected) {
        nodeElement
            .style('opacity', 1)
            .style('filter', 'drop-shadow(0 0 8px rgba(33, 150, 243, 0.5))')
        nodeBackground
            .attr('stroke', '#2196F3')
            .attr('stroke-width', 3)
    } else {
        nodeElement
            .style('opacity', 1)
            .style('filter', 'none')

        if (node) {
            nodeBackground
                .attr('stroke', getNodeColor(node.type, node.status))
                .attr('stroke-width', 2)
        }
    }
}

/**
 * Clears all visual state caches and queues
 */
export function clearAllVisualCaches(config: VisualCacheConfig): void {
    // Clear connection path cache in hook
    config.clearConnCache()
    config.nodePositionCache.clear()
    config.currentDragPositions.clear()
    config.clearAllDragPositions()
    config.connectionUpdateQueue.clear()
    config.visualUpdateQueue.clear()
    config.zIndexManager.clearState()
    config.rafScheduler.clear()
    lastConnUpdatePos.clear()

    if (config.batchedConnectionUpdateRef.current) {
        cancelAnimationFrame(config.batchedConnectionUpdateRef.current)
        config.batchedConnectionUpdateRef.current = null
    }

    if (config.batchedVisualUpdateRef.current) {
        cancelAnimationFrame(config.batchedVisualUpdateRef.current)
        config.batchedVisualUpdateRef.current = null
    }
}
