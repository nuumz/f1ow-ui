/* eslint-disable @typescript-eslint/no-explicit-any */
import * as d3 from 'd3';
import type { WorkflowNode, Connection } from '../types';

export type CreateNodeDragBehaviorParams = {
    svgRef: React.RefObject<SVGSVGElement>;
    // Connection/drag shared state
    isConnectingRef: React.MutableRefObject<boolean>;
    dragConnectionDataRef: React.MutableRefObject<any>;
    batchedConnectionUpdateRef: React.MutableRefObject<number | null>;
    batchedVisualUpdateRef: React.MutableRefObject<number | null>;
    clearAllDragPositions: () => void;
    clearAllDragTracking: () => void;
    currentDragPositionsRef: React.MutableRefObject<Map<string, { x: number; y: number }>>;
    connectionUpdateQueueRef: React.MutableRefObject<Set<string>>;
    visualUpdateQueueRef: React.MutableRefObject<Set<string>>;
    // Cancellation flag to resolve ESC vs drop race
    cancelDragRef?: React.MutableRefObject<boolean>;
    // Context callbacks
    startDragging: (id: string, pos: { x: number; y: number }) => void;
    updateDragPosition: (x: number, y: number) => void;
    endDragging: () => void;
    getDraggedNodeId: () => string | null;
    isContextDragging: () => boolean;
    // Connections/path
    getCachedSelection: (type: 'connectionLayer') => d3.Selection<SVGGElement, any, any, any> | null;
    clearConnCache: () => void;
    updateConnDragPos: (id: string, pos: { x: number; y: number }) => void;
    connections: Connection[];
    getConnectionPath: (c: Connection, useDragPositions?: boolean) => string;
    // Visual updates
    updateDraggedNodePositionCallback: (id: string, x: number, y: number) => void;
    resetNodeVisualStyleCallback: (nodeElement: d3.Selection<any, any, any, any>, id: string) => void;
    zIndexManager: { organizeNodeZIndexImmediate: () => void; clearState?: () => void };
    nodePositionCacheRef: React.MutableRefObject<Map<string, any>>;
    rafScheduler: { clear?: () => void };
    // Events
    onNodeDrag: (id: string, x: number, y: number) => void;
    onNodeClick: (node: WorkflowNode, ctrlKey?: boolean) => void;
    setDraggedElementRef?: (sel: d3.Selection<any, any, any, any> | null) => void;
};

export function createNodeDragBehavior(params: CreateNodeDragBehaviorParams) {
    const {
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
        cancelDragRef,
        startDragging,
        updateDragPosition,
        endDragging,
        getDraggedNodeId,
        isContextDragging,
        getCachedSelection,
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
        setDraggedElementRef,
    } = params;

    // Throttle context drag position updates to avoid per-move dispatch loops
    let lastContextDragUpdate = 0;

    function dragStarted(this: any, event: any, d: WorkflowNode) {
        // Fresh drag should clear any previous cancellation
        if (cancelDragRef) {
            cancelDragRef.current = false;
        }
        // Clear datum-level cancel marker if exists
        (d as any).__escCancelled = false;
        if (isConnectingRef.current || dragConnectionDataRef.current) {
            event?.sourceEvent?.stopPropagation?.();
            return;
        }

        const svgElement = svgRef.current!;
        const sourceEvent = event.sourceEvent || event;
        const [mouseX, mouseY] = d3.pointer(sourceEvent, svgElement);
        const transform = d3.zoomTransform(svgElement);
        const [canvasX, canvasY] = transform.invert([mouseX, mouseY]);

        const dragData = d as any;
        dragData.dragStartX = canvasX;
        dragData.dragStartY = canvasY;
        dragData.initialX = d.x;
        dragData.initialY = d.y;
        dragData.hasDragged = false;
        dragData.dragStartTime = Date.now();

        if (batchedConnectionUpdateRef.current) {
            cancelAnimationFrame(batchedConnectionUpdateRef.current);
            batchedConnectionUpdateRef.current = null;
        }
        if (batchedVisualUpdateRef.current) {
            cancelAnimationFrame(batchedVisualUpdateRef.current);
            batchedVisualUpdateRef.current = null;
        }

        clearAllDragPositions();
        clearAllDragTracking();
        currentDragPositionsRef.current.clear();
        connectionUpdateQueueRef.current.clear();
        visualUpdateQueueRef.current.clear();

        startDragging(d.id, { x: d.x, y: d.y });
        // Initialize throttled current position update once on start
        updateDragPosition(d.x, d.y);
        const nodeElement = d3.select(this);
        nodeElement.classed('dragging', true);
        setDraggedElementRef?.(nodeElement);

        clearConnCache();
        currentDragPositionsRef.current.set(d.id, { x: d.x, y: d.y });
        updateConnDragPos(d.id, { x: d.x, y: d.y });

        try {
            const connectionLayer = getCachedSelection('connectionLayer');
            if (connectionLayer) {
                connections.forEach((conn) => {
                    const group = connectionLayer.select(`[data-connection-id="${conn.id}"]`);
                    if (!group.empty()) {
                        const pathEl = group.select('.connection-path');
                        const useDragPos = conn.sourceNodeId === d.id || conn.targetNodeId === d.id;
                        const newPath = getConnectionPath(conn, useDragPos);
                        pathEl.attr('d', newPath);
                    }
                });
            }
        } catch {
            // ignore minor drag start visual errors
        }
    }

    function dragged(this: any, event: any, d: WorkflowNode) {
        // If ESC cancelled this drag, ignore subsequent pointer moves
        if (cancelDragRef?.current || (d as any).__escCancelled) {
            const src = event?.sourceEvent;
            src?.stopPropagation?.();
            src?.preventDefault?.();
            return;
        }
        const dragData = d as any;
        if (dragData.initialX === undefined || dragData.initialY === undefined) {
            return;
        }

        const svgElement = svgRef.current!;
        const sourceEvent = event.sourceEvent || event;
        const [mouseX, mouseY] = d3.pointer(sourceEvent, svgElement);
        const transform = d3.zoomTransform(svgElement);
        const [currentCanvasX, currentCanvasY] = transform.invert([mouseX, mouseY]);

        const deltaX = currentCanvasX - dragData.dragStartX;
        const deltaY = currentCanvasY - dragData.dragStartY;

        // Throttle context position dispatch to ~20fps to prevent update-depth warnings
        const now = Date.now();
        if (now - lastContextDragUpdate > 50) {
            lastContextDragUpdate = now;
            updateDragPosition(currentCanvasX, currentCanvasY);
        }

        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
            dragData.hasDragged = true;
        }

        const nodeElement = d3.select(this);
        if (!nodeElement.classed('dragging')) {
            nodeElement.classed('dragging', true);
        }

        const newX = dragData.initialX + deltaX;
        const newY = dragData.initialY + deltaY;

        updateDraggedNodePositionCallback(d.id, newX, newY);
        onNodeDrag(d.id, newX, newY);
    }

    function dragEnded(this: any, event: any, d: WorkflowNode) {
        const dragData = d as any;
        const hasDragged = dragData.hasDragged;
        const isCancelled = !!cancelDragRef?.current || !!(dragData.__escCancelled);
        const dragDuration = Date.now() - (dragData.dragStartTime || 0);
        const nodeElement = d3.select(this);

        if (!isCancelled && hasDragged && dragData.initialX !== undefined && dragData.initialY !== undefined) {
            const svgElement = svgRef.current!;
            const sourceEvent = event.sourceEvent || event;
            const [mouseX, mouseY] = d3.pointer(sourceEvent, svgElement);
            const transform = d3.zoomTransform(svgElement);
            const [currentCanvasX, currentCanvasY] = transform.invert([mouseX, mouseY]);

            const deltaX = currentCanvasX - dragData.dragStartX;
            const deltaY = currentCanvasY - dragData.dragStartY;

            d.x = dragData.initialX + deltaX;
            d.y = dragData.initialY + deltaY;

            nodeElement.attr('transform', `translate(${d.x}, ${d.y})`);
            onNodeDrag(d.id, d.x, d.y);
        }

        // If cancelled, ensure we clear the cancellation flag after we processed end
        if (isCancelled) {
            // Do not trigger click-on-drag-end
            if (cancelDragRef) {
                cancelDragRef.current = false;
            }
            if (dragData.__escCancelled) {
                delete dragData.__escCancelled;
            }
        }

        delete dragData.dragStartX;
        delete dragData.dragStartY;
        delete dragData.initialX;
        delete dragData.initialY;
        delete dragData.hasDragged;
        delete dragData.dragStartTime;

        const currentDraggedNodeId = getDraggedNodeId();
        const isCurrentlyDragging = isContextDragging();
        if (isCurrentlyDragging && currentDraggedNodeId === d.id) {
            endDragging();
        }

        nodeElement.classed('dragging', false);
        setDraggedElementRef?.(null);

        clearAllDragPositions();
        clearAllDragTracking();
        currentDragPositionsRef.current.clear();
        connectionUpdateQueueRef.current.clear();
        visualUpdateQueueRef.current.clear();

        if (batchedConnectionUpdateRef.current) {
            cancelAnimationFrame(batchedConnectionUpdateRef.current);
            batchedConnectionUpdateRef.current = null;
        }
        if (batchedVisualUpdateRef.current) {
            cancelAnimationFrame(batchedVisualUpdateRef.current);
            batchedVisualUpdateRef.current = null;
        }

        resetNodeVisualStyleCallback(nodeElement, d.id);
        zIndexManager.organizeNodeZIndexImmediate();

        try {
            const connectionLayer = getCachedSelection('connectionLayer');
            if (connectionLayer && connections.length > 0) {
                const additionalCacheCleanup = () => {
                    zIndexManager.clearState?.();
                    rafScheduler.clear?.();
                    nodePositionCacheRef.current.clear();
                };

                // Force full refresh using existing helper (require to avoid circular import)
                const { forceCompleteStateSyncAfterDrop } = require('../utils/visual-state-manager');
                forceCompleteStateSyncAfterDrop(
                    d.id,
                    connections,
                    connectionLayer,
                    getConnectionPath,
                    clearConnCache,
                    clearAllDragPositions,
                    additionalCacheCleanup
                );
            }
        } catch {
            // ignore finalize errors in production
        }

        if (!isCancelled && !hasDragged && event.sourceEvent && dragDuration < 500) {
            const ctrlKey = event.sourceEvent.ctrlKey || event.sourceEvent.metaKey;
            onNodeClick(d, ctrlKey);
        }
    }

    const dragBehavior = d3
        .drag<SVGGElement, WorkflowNode>()
        .clickDistance(5)
        .on('start', dragStarted)
        .on('drag', dragged)
        .on('end', dragEnded);

    return dragBehavior;
}
