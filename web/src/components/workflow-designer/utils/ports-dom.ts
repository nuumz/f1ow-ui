/* eslint-disable @typescript-eslint/no-explicit-any */
import * as d3 from 'd3';
import type { Connection, NodeVariant, WorkflowNode } from '../types';
import type { PortDatum } from './ports-hit-test';
import { getPortColor } from './node-utils';
import { getPortHighlightClass } from './port-visuals';
import { calculatePortPosition } from './port-positioning';

type MakePortDragHandlers = (opts?: { logTag?: string; requireTargetOnEnd?: boolean }) => {
    onStart: (event: any, d: any) => void;
    onDrag: (event: any, d: any) => void;
    onEnd: (event: any, d: any) => void;
};

export function renderOutputPorts(
    nodeGroups: d3.Selection<SVGGElement, any, any, any>,
    options: {
        showPorts: boolean;
        connections: Connection[];
        nodeVariant: NodeVariant;
        onPortClick: (nodeId: string, portId: string, type: 'input' | 'output') => void;
        announce: (message: string) => void;
        getConfigurableDimensions: (node: WorkflowNode) => { portRadius?: number } & Record<string, any>;
        getConfigurablePortPositions: (
            node: WorkflowNode,
            portType: 'input' | 'output'
        ) => Array<{ x: number; y: number }>;
        getIsConnectingActive: () => boolean;
        hasLocalDragConnection: () => boolean;
        setLocalDragConnection: (v: { nodeId: string; portId: string; type: 'input' | 'output' } | null) => void;
        dispatch?: (action: any) => void;
        makePortDragHandlers: MakePortDragHandlers;
    }
): void {
    const {
        showPorts,
        connections,
        onPortClick,
        announce,
        getConfigurableDimensions,
        getConfigurablePortPositions,
        getIsConnectingActive,
        hasLocalDragConnection,
        setLocalDragConnection,
        dispatch,
        makePortDragHandlers,
    } = options;

    const outputPortGroups = nodeGroups
        .select('g.output-ports')
        .selectAll<SVGGElement, any>('.output-port-group')
        .data(
            (d: any) => {
                if (!showPorts) {
                    return [];
                }
                return d.outputs.map((output: any) => ({ ...output, nodeId: d.id, nodeData: d }));
            },
            (d: any) => d.id
        )
        .join('g')
        .attr('data-port-id', (d: any) => d.id)
        .attr('data-node-id', (d: any) => d.nodeId)
        .attr('class', (d: any) => {
            const hasConnection = connections.some(
                (conn: Connection) => conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id
            );
            return hasConnection
                ? 'port-group output-port-group connected'
                : 'port-group output-port-group';
        })
        .style('cursor', 'crosshair')
        .style('pointer-events', 'all')
        .attr('role', 'button')
        .attr('tabindex', -1)
        .attr('aria-label', (d: any) => `Output port ${d.id} on ${d.nodeData?.label ?? d.nodeId}`)
        .on('click', (event: any, d: any) => {
            if (getIsConnectingActive() || hasLocalDragConnection()) {
                event.stopPropagation();
                return;
            }
            event.stopPropagation();
            onPortClick(d.nodeId, d.id, 'output');
            announce(
                `Connection started from ${d.nodeData?.label ?? d.nodeId} output ${d.id}. Tab to an input port and press Enter to connect, or press Escape to cancel.`
            );
        })
        .on('keydown.access', (event: KeyboardEvent, d: any) => {
            const isEnter = event.key === 'Enter';
            const isSpace = event.key === ' ' || event.key === 'Spacebar';
            if (!(isEnter || isSpace)) {
                return;
            }
            if (getIsConnectingActive()) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setLocalDragConnection({ nodeId: d.nodeId, portId: d.id, type: 'output' });
            dispatch?.({
                type: 'START_CONNECTION',
                payload: { nodeId: d.nodeId, portId: d.id, type: 'output' },
            });
            announce(
                `Connection started from ${d.nodeData?.label ?? d.nodeId} output ${d.id}. Tab to an input port and press Enter to connect, or press Escape to cancel.`
            );
        })
        .call(
            d3
                .drag<any, any>()
                .clickDistance(4)
                .on('start', makePortDragHandlers({ logTag: 'Output port' }).onStart)
                .on('drag', makePortDragHandlers({ logTag: 'Output port' }).onDrag)
                .on('end', makePortDragHandlers({ logTag: 'Output port' }).onEnd)
        );

    outputPortGroups.selectAll('circle').remove();
    outputPortGroups
        .append('circle')
        .attr('class', 'port-circle output-port-circle')
        .attr('cx', (d: any, i: number) => getConfigurablePortPositions(d.nodeData, 'output')[i]?.x || 0)
        .attr('cy', (d: any, i: number) => getConfigurablePortPositions(d.nodeData, 'output')[i]?.y || 0)
        .attr('r', (d: any) => getConfigurableDimensions(d.nodeData).portRadius || 6)
        .attr('fill', getPortColor('any'))
        .attr('stroke', '#8d8d8d')
        .attr('stroke-width', 2);
}

export function renderInputPorts(
    nodeGroups: d3.Selection<SVGGElement, any, any, any>,
    options: {
        showPorts: boolean;
        getConfigurableDimensions: (node: WorkflowNode) => { portRadius?: number } & Record<string, any>;
        getConfigurablePortPositions: (
            node: WorkflowNode,
            portType: 'input' | 'output'
        ) => Array<{ x: number; y: number }>;
        canDropOnPort?: (nodeId: string, portId: string, type: 'input' | 'output') => boolean;
        getIsConnectingActive: () => boolean;
        getConnectionStart: () => { nodeId: string; portId: string; type: 'input' | 'output' } | null;
        onPortDragEnd: (targetNodeId?: string, targetPortId?: string, canvasX?: number, canvasY?: number) => void;
        clearConnectionState: () => void;
        announce: (message: string) => void;
        setKeyboardConnecting: (v: boolean) => void;
    }
): void {
    const {
        showPorts,
        getConfigurableDimensions,
        getConfigurablePortPositions,
        canDropOnPort,
        getIsConnectingActive,
        getConnectionStart,
        onPortDragEnd,
        clearConnectionState,
        announce,
        setKeyboardConnecting,
    } = options;

    const inputPortGroups = nodeGroups
        .select('g.input-ports')
        .selectAll<SVGGElement, any>('.input-port-group')
        .data(
            (d: any) => {
                if (!showPorts) {
                    return [];
                }
                return d.inputs.map((input: any) => ({ ...input, nodeId: d.id, nodeData: d }));
            },
            (d: any) => d.id
        )
        .join('g')
        .attr('data-port-id', (d: any) => d.id)
        .attr('data-node-id', (d: any) => d.nodeId)
        .attr('class', 'port-group input-port-group')
        .attr('role', 'button')
        .attr('tabindex', -1)
        .attr('aria-label', (d: any) => `Input port ${d.id} on ${d.nodeData?.label ?? d.nodeId}`)
        .on('keydown.access', (event: KeyboardEvent, d: any) => {
            const isEnter = event.key === 'Enter';
            const isSpace = event.key === ' ' || event.key === 'Spacebar';
            if (!(isEnter || isSpace)) {
                return;
            }
            if (!getIsConnectingActive()) {
                return;
            }
            const cs = getConnectionStart();
            if (cs?.type !== 'output') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const canDrop = canDropOnPort?.(d.nodeId, d.id, 'input') ?? false;
            if (canDrop) {
                onPortDragEnd(d.nodeId, d.id, undefined, undefined);
                clearConnectionState();
                announce(`Connected ${cs.nodeId} ${cs.portId} to ${d.nodeId} ${d.id}`);
                setKeyboardConnecting(false);
            } else {
                announce('Invalid target port');
            }
        });

    inputPortGroups.selectAll('circle').remove();
    inputPortGroups
        .append('circle')
        .attr('class', 'port-circle input-port-circle')
        .attr('cx', (d: any, i: number) => getConfigurablePortPositions(d.nodeData, 'input')[i]?.x || 0)
        .attr('cy', (d: any, i: number) => getConfigurablePortPositions(d.nodeData, 'input')[i]?.y || 0)
        .attr('r', (d: any) => getConfigurableDimensions(d.nodeData).portRadius || 6)
        .attr('fill', getPortColor('any'))
        .attr('stroke', '#333')
        .attr('stroke-width', 2)
        .style('pointer-events', 'none');
}

export function renderSidePorts(
    nodeGroups: d3.Selection<SVGGElement, any, any, any>,
    options: {
        isArchitectureMode: boolean;
        showPorts: boolean;
        connections: Connection[];
        getConfigurableDimensions: (node: WorkflowNode) => { width?: number; height?: number } & Record<string, any>;
        nodeVariant: NodeVariant;
        modeId: string | undefined;
        onPortClick: (nodeId: string, portId: string, type: 'input' | 'output') => void;
        makePortDragHandlers: MakePortDragHandlers;
    }
): void {
    const {
        isArchitectureMode,
        showPorts,
        connections,
        getConfigurableDimensions,
        modeId,
        onPortClick,
        makePortDragHandlers,
    } = options;

    const sidePortGroups = nodeGroups
        .select('g.side-ports')
        .selectAll<SVGGElement, any>('.side-port-group')
        .data((d: any) => {
            if (!isArchitectureMode || !showPorts) {
                return [];
            }
            const dim = getConfigurableDimensions(d);
            const halfW = (dim.width || 0) / 2;
            const halfH = (dim.height || 0) / 2;
            const sides = [
                { id: '__side-top', x: 0, y: -halfH, kind: 'input' },
                { id: '__side-right', x: halfW, y: 0, kind: 'output' },
                { id: '__side-bottom', x: 0, y: halfH, kind: 'output' },
                { id: '__side-left', x: -halfW, y: 0, kind: 'input' },
            ];
            const hasMultipleInputs = Array.isArray(d.inputs) && d.inputs.length > 1;
            const hasMultipleOutputs = Array.isArray(d.outputs) && d.outputs.length > 1;
            const filtered = sides.filter((s) => {
                if (s.id === '__side-left' && hasMultipleInputs) {
                    return false;
                }
                if (s.id === '__side-right' && hasMultipleOutputs) {
                    return false;
                }
                return true;
            });
            return filtered.map((s) => ({ nodeId: d.id, nodeData: d, id: s.id, kind: s.kind, x: s.x, y: s.y }));
        })
        .join('g')
        .attr('class', (d: any) => {
            const isConnected = connections.some(
                (conn: Connection) =>
                    (conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id) ||
                    (conn.targetNodeId === d.nodeId && conn.targetPortId === d.id)
            );
            const inputHL = getPortHighlightClass(d.nodeId, d.id, 'input', connections, modeId as any);
            const outputHL = getPortHighlightClass(d.nodeId, d.id, 'output', connections, modeId as any);
            const classes = ['side-port-group', 'port-group'];
            if (isConnected) {
                classes.push('connected');
            }
            if (inputHL) {
                classes.push(inputHL);
            }
            if (outputHL) {
                classes.push(outputHL);
            }
            return classes.join(' ');
        })
        .style('cursor', 'crosshair')
        .style('pointer-events', 'all')
        .on('click', (event: any, d: any) => {
            event.stopPropagation();
            onPortClick(d.nodeId, d.id, d.kind === 'input' ? 'input' : 'output');
        })
        .call(
            d3
                .drag<any, any>()
                .clickDistance(4)
                .on('start', makePortDragHandlers().onStart)
                .on('drag', makePortDragHandlers().onDrag)
                .on('end', makePortDragHandlers().onEnd)
        );

    sidePortGroups.selectAll('rect').remove();
    sidePortGroups
        .append('rect')
        .attr('class', 'side-port-rect')
        .attr('x', (d: any) => d.x - 6)
        .attr('y', (d: any) => d.y - 6)
        .attr('width', 12)
        .attr('height', 12)
        .attr('rx', 2)
        .attr('ry', 2)
        .attr('fill', '#CCCCCC')
        .attr('stroke', '#8d8d8d')
        .attr('stroke-width', 1.5)
        .style('pointer-events', 'all');
}

export function renderBottomPorts(
    nodeGroups: d3.Selection<SVGGElement, any, any, any>,
    options: {
        showPorts: boolean;
        connections: Connection[];
        nodeVariant: NodeVariant;
        isConnecting: boolean;
        connectionStart: { nodeId: string; portId: string; type: 'input' | 'output' } | null;
        canDropOnPort?: (nodeId: string, portId: string, type: 'input' | 'output') => boolean;
        isNodeSelected: (nodeId: string) => boolean;
        nodeMap: Map<string, WorkflowNode>;
        modeId: string | undefined;
        getConfigurableDimensions: (node: WorkflowNode) => { portRadius?: number } & Record<string, any>;
        onPortDragStart: (nodeId: string, portId: string, portType: 'input' | 'output') => void;
        onPortDrag: (x: number, y: number) => void;
        onPortDragEnd: (targetNodeId?: string, targetPortId?: string, canvasX?: number, canvasY?: number) => void;
        getHitTestPortRadius: (pd: PortDatum) => number;
        canBottomPortAcceptConnection: (
            nodeId: string,
            portId: string,
            connections: Connection[],
            nodeMap: Map<string, WorkflowNode>,
            modeId?: string
        ) => boolean;
        resolveDragEndTarget: (
            svgElement: SVGSVGElement,
            canvasX: number,
            canvasY: number,
            nodes: WorkflowNode[],
            _unused: null,
            getHitTestPortRadius: (pd: PortDatum) => number
        ) => { nodeId?: string; portId?: string };
        nodes: WorkflowNode[];
        dbg?: { warn: (...args: unknown[]) => void };
    }
): void {
    const {
        showPorts,
        connections,
        nodeVariant,
        isConnecting,
        connectionStart,
        canDropOnPort,
        isNodeSelected,
        nodeMap,
        modeId,
        getConfigurableDimensions,
        onPortDragStart,
        onPortDrag,
        onPortDragEnd,
        getHitTestPortRadius,
        canBottomPortAcceptConnection,
        resolveDragEndTarget,
        nodes,
        dbg,
    } = options;

    const bottomPortGroups = nodeGroups
        .filter((d: any) => d.bottomPorts && d.bottomPorts.length > 0)
        .select('g.bottom-ports')
        .selectAll<SVGGElement, any>('.bottom-port-group')
        .data(
            (d: any) => {
                if (!showPorts || !d.bottomPorts) {
                    return [];
                }
                return d.bottomPorts.map((port: any) => ({ ...port, nodeId: d.id, nodeData: d }));
            },
            (d: any) => d.id
        )
        .join('g')
        .attr('data-port-id', (d: any) => d.id)
        .attr('data-node-id', (d: any) => d.nodeId)
        .attr('class', 'bottom-port-group')
        .style('cursor', 'crosshair')
        .style('pointer-events', 'all')
        .call(
            d3
                .drag<any, any>()
                .clickDistance(4)
                .on('start', (event: any, d: any) => {
                    dbg?.warn?.('🚀 Plus button drag START:', d.nodeId, d.id);
                    event.sourceEvent.stopPropagation();
                    event.sourceEvent.preventDefault();
                    onPortDragStart(d.nodeId, d.id, 'output');
                })
                .on('drag', (event: any) => {
                    const svgElement = event.sourceEvent.target.ownerSVGElement as SVGSVGElement;
                    const [x, y] = d3.pointer(event.sourceEvent, svgElement);
                    const transform = d3.zoomTransform(svgElement);
                    const [canvasX, canvasY] = transform.invert([x, y]);
                    onPortDrag(canvasX, canvasY);
                })
                .on('end', (event: any) => {
                    dbg?.warn?.('🚀 Plus button drag END');
                    const svgElement = event.sourceEvent.target.ownerSVGElement as SVGSVGElement;
                    const currentTransform = d3.zoomTransform(svgElement);
                    const [screenX, screenY] = d3.pointer(event.sourceEvent, svgElement);
                    const [canvasX, canvasY] = currentTransform.invert([screenX, screenY]);
                    const result = resolveDragEndTarget(
                        svgElement,
                        canvasX,
                        canvasY,
                        nodes,
                        null,
                        getHitTestPortRadius
                    );
                    if (result.nodeId && result.portId) {
                        onPortDragEnd(result.nodeId, result.portId, canvasX, canvasY);
                    } else {
                        onPortDragEnd(undefined, undefined, canvasX, canvasY);
                    }
                })
        );

    // Diamond
    bottomPortGroups.selectAll('path').remove();
    bottomPortGroups
        .append('path')
        .attr('class', 'bottom-port-diamond')
        .attr('d', (d: any) => {
            const size = getConfigurableDimensions(d.nodeData).portRadius || 6;
            return `M 0,${-size} L ${size},0 L 0,${size} L ${-size},0 Z`;
        })
        .attr('transform', (d: any) => {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            const relX = abs.x - d.nodeData.x;
            const relY = abs.y - d.nodeData.y;
            return `translate(${relX}, ${relY})`;
        })
        .attr('fill', (d: any) => {
            if (isConnecting && connectionStart && connectionStart.type === 'output') {
                const canDrop = canDropOnPort ? canDropOnPort(d.nodeId, d.id, 'input') : false;
                return canDrop ? '#4CAF50' : '#ff5722';
            }
            return '#A8A9B4';
        })
        .attr('stroke', 'none');

    // Connector lines
    bottomPortGroups.selectAll('line').remove();
    bottomPortGroups
        .append('line')
        .attr('class', 'bottom-port-connector')
        .attr('x1', (d: any) => {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            return abs.x - d.nodeData.x;
        })
        .attr('y1', (d: any) => {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            return abs.y - d.nodeData.y;
        })
        .attr('x2', (d: any) => {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            return abs.x - d.nodeData.x;
        })
        .attr('y2', (d: any) => {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            const posY = abs.y - d.nodeData.y;
            const hasConnection = connections.some(
                (conn: Connection) => conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id
            );
            const nodeIsSelected = isNodeSelected(d.nodeId);
            let shouldShowLine = false;
            if (!hasConnection) {
                shouldShowLine = true;
            } else if (nodeIsSelected) {
                shouldShowLine = canBottomPortAcceptConnection(d.nodeId, d.id, connections, nodeMap, modeId);
            }
            return shouldShowLine ? posY + 16 : posY;
        })
        .attr('stroke', (d: any) => {
            const nodeIsSelected = isNodeSelected(d.nodeId);
            const hasConnection = connections.some(
                (conn: Connection) => conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id
            );
            if (nodeIsSelected && hasConnection) {
                const canAcceptMore = canBottomPortAcceptConnection(
                    d.nodeId,
                    d.id,
                    connections,
                    nodeMap,
                    modeId
                );
                if (canAcceptMore) {
                    return '#4CAF50';
                }
            }
            return '#A8A9B4';
        })
        .attr('stroke-width', (d: any) => {
            const nodeIsSelected = isNodeSelected(d.nodeId);
            const hasConnection = connections.some(
                (conn: Connection) => conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id
            );
            return nodeIsSelected && hasConnection ? 3 : 2;
        })
        .style('pointer-events', 'none');

    // Plus buttons and labels
    bottomPortGroups.each(function (d: any) {
        const group = d3.select(this);
        const hasConnection = connections.some(
            (conn: Connection) => conn.sourceNodeId === d.nodeId && conn.sourcePortId === d.id
        );
        const nodeIsSelected = isNodeSelected(d.nodeId);
        let shouldShowButton = false;
        if (nodeIsSelected) {
            shouldShowButton = canBottomPortAcceptConnection(d.nodeId, d.id, connections, nodeMap, modeId);
        } else {
            shouldShowButton = !hasConnection;
        }

        group.selectAll('.plus-button-container').remove();
        group.selectAll('.bottom-port-label-container').remove();

        if (shouldShowButton) {
            const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
            const x = abs.x - d.nodeData.x;
            const y = abs.y - d.nodeData.y + 36;
            const plusButtonContainer = group
                .append('g')
                .attr('class', 'plus-button-container')
                .attr('transform', `translate(${x}, ${y})`)
                .style('cursor', 'crosshair')
                .style('pointer-events', 'all');

            const plusButton = plusButtonContainer
                .append('g')
                .attr('class', 'plus-button')
                .style('cursor', 'crosshair')
                .style('pointer-events', 'all');

            // Background
            plusButton
                .append('rect')
                .attr('class', 'plus-button-bg')
                .attr('x', -8)
                .attr('y', -8)
                .attr('width', 16)
                .attr('height', 16)
                .attr('rx', 2)
                .attr('ry', 2)
                .attr('fill', () => {
                    if (hasConnection && nodeIsSelected) {
                        return '#4CAF50';
                    }
                    return '#8A8B96';
                })
                .attr('stroke', () => (hasConnection && nodeIsSelected ? '#388E3C' : 'none'))
                .attr('stroke-width', () => (hasConnection && nodeIsSelected ? 1 : 0));

            // Plus symbol
            plusButton
                .append('line')
                .attr('class', 'plus-horizontal')
                .attr('x1', -4)
                .attr('y1', 0)
                .attr('x2', 4)
                .attr('y2', 0)
                .attr('stroke', 'white')
                .attr('stroke-width', 1.5)
                .attr('stroke-linecap', 'round');
            plusButton
                .append('line')
                .attr('class', 'plus-vertical')
                .attr('x1', 0)
                .attr('y1', -4)
                .attr('x2', 0)
                .attr('y2', 4)
                .attr('stroke', 'white')
                .attr('stroke-width', 1.5)
                .attr('stroke-linecap', 'round');
        }

        // Label
        const abs = calculatePortPosition(d.nodeData, d.id, 'bottom', nodeVariant);
        const labelX = abs.x - d.nodeData.x;
        const labelY = abs.y - d.nodeData.y + 15;
        const labelContainer = group
            .append('g')
            .attr('class', 'bottom-port-label-container')
            .attr('transform', `translate(${labelX}, ${labelY})`);
        const labelText = d.label || d.id;
        const textWidth = labelText.length * 5.5;
        const padding = 8;
        labelContainer
            .append('rect')
            .attr('class', 'bottom-port-label-bg')
            .attr('x', -textWidth / 2 - padding / 2)
            .attr('y', -7)
            .attr('width', textWidth + padding)
            .attr('height', 12)
            .attr('fill', '#ffffff5b')
            .attr('stroke', 'none');
        labelContainer
            .append('text')
            .attr('class', 'bottom-port-label')
            .attr('x', 0)
            .attr('y', 0)
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'middle')
            .attr('font-size', '8px')
            .attr('font-weight', '500')
            .attr('fill', '#2c3e50')
            .attr('stroke', 'none')
            .attr('pointer-events', 'none')
            .style('user-select', 'none')
            .text(labelText);
    });
}
