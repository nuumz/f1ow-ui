/**
 * Connection Utilities - Main API
 * Provides high-level functions for connection path generation and management
 * Uses modular architecture with focused utility modules
 */

import type { WorkflowNode, PortPosition, NodeVariant } from '../types'
import * as d3 from 'd3'
import { getShapeAwareDimensions, NODE_WIDTH, NODE_MIN_HEIGHT } from './node-utils'
import { computePortVisualAttributes, applyPortVisualAttributes } from './port-visuals'

// U-Shape routing constants (centralized for easy tuning)
const U_SHAPE_CONFIG = {
  // Proximity threshold for triggering U-shape routing
  PROXIMITY_THRESHOLD: FIXED_LEAD_LENGTH, // 50px
  // Safe clearance around node boxes
  SAFE_CLEARANCE: 16,
  // Arrowhead trimming distance
  MARKER_TRIM: 5.5,
  // Buffer for obstacle detection
  OBSTACLE_BUFFER: 20
} as const

// Type aliases
type MarkerState = 'default' | 'selected' | 'hover';
export type DesignerMode = 'workflow' | 'architecture' | undefined;

// Shared helpers for virtual side ports (architecture omni-ports)
const isVirtualSidePortId = (id: string) => id.startsWith('__side-')

// Architecture mode fixed sizing (must match WorkflowCanvas getConfigurableDimensions)
const ARCH_SIZE = 56
// Architecture mode connection corner radius (keep all 90° bends consistent)
const ARCH_CONNECTION_RADIUS = 12

// Architecture mode: thresholds for forcing top-side termination when starting from a bottom port
// If source is above target top by at least FORCE_TOP_MIN_DY and port-to-port distance exceeds FORCE_TOP_MIN_DIST,
// pick the target's top side for clearer routing.
const FORCE_TOP_MIN_DY = 75
const FORCE_TOP_MIN_DIST = 100

// Architecture mode: thresholds for forcing bottom-side termination when starting from a top port
// If target's bottom is above the source top by at least FORCE_BOTTOM_MIN_DY and port-to-port distance exceeds FORCE_BOTTOM_MIN_DIST,
// pick the target's bottom side for clearer routing.
const FORCE_BOTTOM_MIN_DY = 75
const FORCE_BOTTOM_MIN_DIST = 100

// Mode-aware dimensions helper
function getModeAwareDimensions(node: WorkflowNode, modeId?: string) {
  if (modeId === 'architecture') {
    return { width: ARCH_SIZE, height: ARCH_SIZE }
  }
  const dims = getShapeAwareDimensions(node)
  return { width: dims.width || 200, height: dims.height || 80 }
}

const getVirtualSidePortPosition = (node: WorkflowNode, portId: string): PortPosition => {
  const dims = getShapeAwareDimensions(node)
  const halfW = (dims.width || 200) / 2
  const halfH = (dims.height || 80) / 2
  switch (portId) {
    case '__side-top':
      return { x: node.x, y: node.y - halfH }
    case '__side-right':
      return { x: node.x + halfW, y: node.y }
    case '__side-bottom':
      return { x: node.x, y: node.y + halfH }
    case '__side-left':
      return { x: node.x - halfW, y: node.y }
    default:
      return { x: node.x, y: node.y }
  }
}

// Mode-aware virtual side port position
function getVirtualSidePortPositionForMode(node: WorkflowNode, portId: string, modeId?: string): PortPosition {
  const dims = getModeAwareDimensions(node, modeId)
  const halfW = (dims.width) / 2
  const halfH = (dims.height) / 2
  switch (portId) {
    case '__side-top':
      return { x: node.x, y: node.y - halfH }
    case '__side-right':
      return { x: node.x + halfW, y: node.y }
    case '__side-bottom':
      return { x: node.x, y: node.y + halfH }
    case '__side-left':
      return { x: node.x - halfW, y: node.y }
    default:
      return { x: node.x, y: node.y }
  }
}

// Import modular utilities
import {
  calculatePortPosition as calculatePortPositionCore,
  getPortType,
  isBottomPort,
  validatePortExists
} from './port-positioning'
import {
  generateConnectionPath,
  generatePreviewPath,
  generateOffsetPath,
  calculateConnectionOffset,
  getConnectionFlow,
  validatePathInputs,
  generateAdaptiveOrthogonalRoundedPathSmart,
  FIXED_LEAD_LENGTH,
  type PathConfig,
  buildRoundedPathFromPoints
} from './path-generation'
import {
  getConnectionGroupInfo as getConnectionGroupInfoCore,
  analyzeConnectionGroups as analyzeConnectionGroupsCore
} from './connection-analysis'

// Façade exports for connection logic (single import point)
export type { PortPosition } from '../types'
export type { PathConfig, ConnectionFlow } from './path-generation'
export {
  generateOrthogonalRoundedPath,
  generateAdaptiveOrthogonalRoundedPath,
  generateAdaptiveOrthogonalRoundedPathSmart,
  FIXED_LEAD_LENGTH,
} from './path-generation'
export type {
  AnalyzableConnection,
  GroupedConnection,
  ConnectionGroupInfo,
  ConnectionGroupStats,
} from './connection-analysis'
export {
  getConnectionGroupInfo as getConnectionGroupInfoFromList,
  findConnectionsBetweenNodes,
  findConnectionsForNode,
} from './connection-analysis'

// Local helpers -------------------------------------------------------------
type PortSide = 'top' | 'bottom' | 'left' | 'right' | 'unknown'
// Shared alias for architecture virtual side-ports
type SidePortId = '__side-left' | '__side-right' | '__side-top' | '__side-bottom'
type PortType = 'input' | 'output' | 'bottom'
function buildNodeBox(node: WorkflowNode) {
  const dims = getShapeAwareDimensions(node)
  const width = dims.width || 200
  const height = dims.height || 80
  return { x: node.x - width / 2, y: node.y - height / 2, width, height }
}

function buildNodeBoxModeAware(node: WorkflowNode, modeId?: string) {
  const dims = getModeAwareDimensions(node, modeId)
  const width = dims.width
  const height = dims.height
  return { x: node.x - width / 2, y: node.y - height / 2, width, height }
}

// Detect which side of the node a port position lies on to infer segment orientation
// NOTE: legacy detectPortSide removed; use detectPortSideModeAware instead

function detectPortSideModeAware(
  node: WorkflowNode,
  portId: string,
  pos: PortPosition,
  modeId?: string
): PortSide {
  if (portId === '__side-top') { return 'top' }
  if (portId === '__side-right') { return 'right' }
  if (portId === '__side-bottom') { return 'bottom' }
  if (portId === '__side-left') { return 'left' }

  const dims = getModeAwareDimensions(node, modeId)
  const halfW = dims.width / 2
  const halfH = dims.height / 2
  const leftX = node.x - halfW
  const rightX = node.x + halfW
  const topY = node.y - halfH
  const bottomY = node.y + halfH
  const eps = 0.5

  if (Math.abs(pos.x - rightX) <= eps) { return 'right' }
  if (Math.abs(pos.x - leftX) <= eps) { return 'left' }
  if (Math.abs(pos.y - topY) <= eps) { return 'top' }
  if (Math.abs(pos.y - bottomY) <= eps) { return 'bottom' }

  // Fallback: choose nearest side
  const dxLeft = Math.abs(pos.x - leftX)
  const dxRight = Math.abs(pos.x - rightX)
  const dyTop = Math.abs(pos.y - topY)
  const dyBottom = Math.abs(pos.y - bottomY)
  const minX = Math.min(dxLeft, dxRight)
  const minY = Math.min(dyTop, dyBottom)
  if (minX < minY) { return dxLeft < dxRight ? 'left' : 'right' }
  return dyTop < dyBottom ? 'top' : 'bottom'
}

type EdgeSide = 'top' | 'bottom' | 'left' | 'right' | 'unknown'
type AxisOrientation = 'vertical' | 'horizontal'

function sideToOrientation(side: EdgeSide): AxisOrientation {
  if (side === 'top' || side === 'bottom') { return 'vertical' }
  return 'horizontal'
}



// Choose best target side based on approach vector (leadPoint -> target center)
function chooseAutoTargetSide(
  approachFrom: PortPosition,
  targetNode: WorkflowNode
): SidePortId {
  const cx = targetNode.x
  const cy = targetNode.y
  const dx = cx - approachFrom.x
  const dy = cy - approachFrom.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal approach dominates
    return dx > 0 ? '__side-left' : '__side-right'
  }
  // Vertical approach dominates
  return dy > 0 ? '__side-top' : '__side-bottom'
}

// chooseEndOrientationFromBox removed (unused after refactor)

// Helper: compute source port position for preview, mode-aware
function computeSourcePosForPreview(
  sourceNode: WorkflowNode,
  sourcePortId: string,
  portType: 'bottom' | 'output',
  variant: NodeVariant,
  modeId: string
): PortPosition {
  if (modeId !== 'architecture') {
    return isVirtualSidePortId(sourcePortId)
      ? getVirtualSidePortPosition(sourceNode, sourcePortId)
      : calculatePortPositionCore(sourceNode, sourcePortId, portType, variant)
  }
  if (isVirtualSidePortId(sourcePortId)) {
    return getVirtualSidePortPositionForMode(sourceNode, sourcePortId, modeId)
  }
  const dims = getModeAwareDimensions(sourceNode, modeId)
  if (portType === 'bottom') {
    const ports = sourceNode.bottomPorts || []
    const idx = Math.max(0, ports.findIndex(p => p.id === sourcePortId))
    const portCount = ports.length
    const usableWidth = Math.min(dims.width * 0.8, dims.width - 70)
    if (portCount === 2) {
      const spacing = usableWidth / 3
      const positions = [-spacing, spacing]
      return { x: sourceNode.x + (positions[idx] || 0), y: sourceNode.y + dims.height / 2 }
    }
    if (portCount === 3) {
      const halfWidth = usableWidth / 2
      const positions = [-halfWidth, 0, halfWidth]
      return { x: sourceNode.x + (positions[idx] || 0), y: sourceNode.y + dims.height / 2 }
    }
    if (portCount >= 4) {
      const spacing = usableWidth / (portCount - 1)
      const x = -usableWidth / 2 + spacing * idx
      return { x: sourceNode.x + x, y: sourceNode.y + dims.height / 2 }
    }
    return { x: sourceNode.x, y: sourceNode.y + dims.height / 2 }
  }
  const ports = sourceNode.outputs
  const idx = Math.max(0, ports.findIndex(p => p.id === sourcePortId))
  const count = ports.length || 1
  const spacing = dims.height / (count + 1)
  const y = -dims.height / 2 + spacing * (idx + 1)
  const x = dims.width / 2
  return { x: sourceNode.x + x, y: sourceNode.y + y }
}

// Helper: trim a point outward by side (architecture marker)
function trimPointBySide(pt: { x: number; y: number }, side: SidePortId | undefined, sourcePos: PortPosition, HALF_MARKER = 5.5) {
  // Prefer explicit outward trim based on side to avoid arrowheads entering nodes.
  if (side === '__side-left') { return { x: pt.x - HALF_MARKER, y: pt.y } }
  if (side === '__side-right') { return { x: pt.x + HALF_MARKER, y: pt.y } }
  if (side === '__side-top') { return { x: pt.x, y: pt.y - HALF_MARKER } }
  if (side === '__side-bottom') { return { x: pt.x, y: pt.y + HALF_MARKER } }

  // Fallback when side is undefined: infer direction from the approach vector
  const dx = pt.x - sourcePos.x
  const dy = pt.y - sourcePos.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    const dirX = Math.sign(dx) || 1
    return { x: pt.x + dirX * HALF_MARKER, y: pt.y }
  }
  const dirY = Math.sign(dy) || 1
  return { x: pt.x, y: pt.y + dirY * HALF_MARKER }
}

// Helper: compute snap end for architecture preview
type SnapResult = { previewEnd: { x: number; y: number }; chosenSide?: SidePortId; endOrientation?: 'vertical' | 'horizontal' }

function snapToHoverTargetBox(args: {
  hoverTargetBox: { x: number; y: number; width: number; height: number }
  startSide: PortSide
  isSourceBottomPort: boolean
  sourcePos: PortPosition
}): SnapResult | null {
  const { hoverTargetBox, startSide: _startSide, isSourceBottomPort, sourcePos } = args
  const centerX = hoverTargetBox.x + hoverTargetBox.width / 2
  const centerY = hoverTargetBox.y + hoverTargetBox.height / 2
  const SNAP_THRESHOLD = FIXED_LEAD_LENGTH * 2
  if (isSourceBottomPort) {
    const topY = hoverTargetBox.y
    const bottomY = hoverTargetBox.y + hoverTargetBox.height
    const useBottom = (topY - sourcePos.y) < SNAP_THRESHOLD
    return { previewEnd: { x: centerX, y: useBottom ? bottomY : topY }, chosenSide: useBottom ? '__side-bottom' : '__side-top', endOrientation: 'vertical' }
  }
  // For non-bottom starts (left, right, top), choose optimal side based on geometry
  const mockTarget: WorkflowNode = { id: 'mock-target', label: 'Mock Target', x: centerX, y: centerY, type: 'mock', inputs: [], outputs: [], config: {} }
  const optimalSide = chooseAutoTargetSide(sourcePos, mockTarget)
  let posBySide: { x: number; y: number }
  switch (optimalSide) {
    case '__side-left': posBySide = { x: hoverTargetBox.x, y: centerY }; break
    case '__side-right': posBySide = { x: hoverTargetBox.x + hoverTargetBox.width, y: centerY }; break
    case '__side-top': posBySide = { x: centerX, y: hoverTargetBox.y }; break
    default: posBySide = { x: centerX, y: hoverTargetBox.y + hoverTargetBox.height }
  }
  return { previewEnd: posBySide, chosenSide: optimalSide, endOrientation: (optimalSide === '__side-left' || optimalSide === '__side-right') ? 'horizontal' : 'vertical' }
}

function snapToAvailableNodes(args: {
  availableNodes?: WorkflowNode[]
  previewPosition: { x: number; y: number }
  sourceNode: WorkflowNode
  sourcePos: PortPosition
}): SnapResult | null {
  const { availableNodes, previewPosition, sourceNode, sourcePos } = args
  if (!availableNodes || availableNodes.length === 0) { return null }
  const snapTarget = findNearbySnapTargets(previewPosition, availableNodes, sourceNode, sourcePos, 50)
  if (!snapTarget) { return null }
  return {
    previewEnd: { x: snapTarget.x, y: snapTarget.y },
    chosenSide: snapTarget.targetSide,
    endOrientation: (snapTarget.targetSide === '__side-left' || snapTarget.targetSide === '__side-right') ? 'horizontal' : 'vertical'
  }
}

function computeArchitecturePreviewSnapEnd(params: {
  hoverTargetBox?: { x: number; y: number; width: number; height: number }
  availableNodes?: WorkflowNode[]
  previewPosition: { x: number; y: number }
  startSide: PortSide
  isSourceBottomPort: boolean
  sourcePos: PortPosition
  sourceNode: WorkflowNode
}): SnapResult {
  const { hoverTargetBox, availableNodes, previewPosition, startSide, isSourceBottomPort, sourcePos, sourceNode } = params
  const hoverSnap = hoverTargetBox
    ? snapToHoverTargetBox({ hoverTargetBox, startSide, isSourceBottomPort, sourcePos })
    : null
  if (hoverSnap) { return hoverSnap }
  const nodeSnap = snapToAvailableNodes({ availableNodes, previewPosition, sourceNode, sourcePos })
  if (nodeSnap) { return nodeSnap }
  const gridSize = 20
  return { previewEnd: { x: Math.round(previewPosition.x / gridSize) * gridSize, y: Math.round(previewPosition.y / gridSize) * gridSize } }
}

// Helper: bottom U route for preview
function maybeBottomUPathForPreview(args: {
  isSourceBottomPort: boolean
  hoverTargetBox?: { x: number; y: number; width: number; height: number }
  previewEnd: { x: number; y: number }
  sourceNode: WorkflowNode
  sourcePos: PortPosition
  HALF_MARKER: number
}): string | null {
  const { isSourceBottomPort, hoverTargetBox, previewEnd, sourceNode, sourcePos, HALF_MARKER } = args
  if (!(isSourceBottomPort && hoverTargetBox && previewEnd.y === hoverTargetBox.y + hoverTargetBox.height)) { return null }
  const srcBox = buildNodeBox(sourceNode)
  const targetBottomY = hoverTargetBox.y + hoverTargetBox.height
  const boxesBottom = Math.max(srcBox.y + srcBox.height, targetBottomY)
  const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
  const minBelow = Math.max(sourcePos.y, targetBottomY) + FIXED_LEAD_LENGTH
  const midY = Math.max(boxesBottom + safeClear, minBelow)
  // Trim end by marker size using shared helper to align arrow tip with bottom edge
  const bottomUTrimmedEndCorrected = trimPointBySide({ x: previewEnd.x, y: previewEnd.y }, '__side-bottom', sourcePos, HALF_MARKER)
  return [
    `M ${sourcePos.x} ${sourcePos.y}`,
    `L ${sourcePos.x} ${midY}`,
    `L ${bottomUTrimmedEndCorrected.x} ${midY}`,
    `L ${bottomUTrimmedEndCorrected.x} ${bottomUTrimmedEndCorrected.y}`
  ].join(' ')
}

// Helper: top U route for preview
function maybeTopUPathForPreview(args: {
  isSourceTopPort: boolean
  hoverTargetBox?: { x: number; y: number; width: number; height: number }
  previewEnd: { x: number; y: number }
  sourceNode: WorkflowNode
  sourcePos: PortPosition
  HALF_MARKER: number
}): string | null {
  const { isSourceTopPort, hoverTargetBox, previewEnd, sourceNode, sourcePos, HALF_MARKER } = args
  if (!(isSourceTopPort && hoverTargetBox && previewEnd.y === hoverTargetBox.y)) { return null }
  const srcBox = buildNodeBox(sourceNode)
  const targetTopY = hoverTargetBox.y
  const boxesTop = Math.min(srcBox.y, targetTopY)
  const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
  const minAbove = Math.min(sourcePos.y, targetTopY) - FIXED_LEAD_LENGTH
  const midY = Math.min(boxesTop - safeClear, minAbove)
  // Trim end by marker size using shared helper to align arrow tip with top edge
  const topUTrimmedEndCorrected = trimPointBySide({ x: previewEnd.x, y: previewEnd.y }, '__side-top', sourcePos, HALF_MARKER)
  return [
    `M ${sourcePos.x} ${sourcePos.y}`,
    `L ${sourcePos.x} ${midY}`,
    `L ${topUTrimmedEndCorrected.x} ${midY}`,
    `L ${topUTrimmedEndCorrected.x} ${topUTrimmedEndCorrected.y}`
  ].join(' ')
}

// Helper: check if there are obstacles in the U-path area (basic implementation)
function hasObstacleInPath(
  midX: number,
  sourceY: number,
  targetY: number,
  availableNodes?: WorkflowNode[],
  excludeNodes: string[] = []
): boolean {
  if (!availableNodes || availableNodes.length === 0) {
    return false
  }

  const minY = Math.min(sourceY, targetY) - U_SHAPE_CONFIG.OBSTACLE_BUFFER
  const maxY = Math.max(sourceY, targetY) + U_SHAPE_CONFIG.OBSTACLE_BUFFER

  return availableNodes.some(node => {
    if (excludeNodes.includes(node.id)) {
      return false
    }

    const nodeBox = buildNodeBox(node)
    const nodeRight = nodeBox.x + nodeBox.width
    const nodeLeft = nodeBox.x
    const nodeTop = nodeBox.y
    const nodeBottom = nodeBox.y + nodeBox.height

    // Check if node intersects with the horizontal part of U-path
    const horizontalIntersects =
      (midX >= nodeLeft && midX <= nodeRight) &&
      (nodeBottom >= minY && nodeTop <= maxY)

    return horizontalIntersects
  })
}

// Helper: horizontal U route for preview
function maybeHorizontalUPathForPreview(args: {
  hoverTargetBox?: { x: number; y: number; width: number; height: number }
  sourceNode: WorkflowNode
  sourcePortId: string
  sourcePos: PortPosition
  modeId: string
  availableNodes?: WorkflowNode[]
}): string | null {
  const { hoverTargetBox, sourceNode, sourcePortId, sourcePos, modeId, availableNodes } = args
  if (!hoverTargetBox) { return null }
  const startSidePrev = detectPortSideModeAware(sourceNode, sourcePortId, sourcePos, modeId)
  const srcBox = buildNodeBox(sourceNode)
  const centerY = hoverTargetBox.y + hoverTargetBox.height / 2
  const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
  // Use shared decision for parity
  const tBox: ArchBox = { x: hoverTargetBox.x, y: hoverTargetBox.y, width: hoverTargetBox.width, height: hoverTargetBox.height }
  const decision = decideHorizontalU(startSidePrev, sourcePos, tBox)
  if (decision.allow && decision.direction === 'right') {
    const rightEdgeCenter = { x: hoverTargetBox.x + hoverTargetBox.width, y: centerY }
    const boxesRight = Math.max(srcBox.x + srcBox.width, hoverTargetBox.x + hoverTargetBox.width)
    const minRight = Math.max(sourcePos.x, rightEdgeCenter.x) + FIXED_LEAD_LENGTH
    const midX = Math.max(boxesRight + safeClear, minRight)
    const hasObs = hasObstacleInPath(midX, sourcePos.y, rightEdgeCenter.y, availableNodes, [sourceNode.id])
    if (hasObs) { return null }
    return [
      `M ${sourcePos.x} ${sourcePos.y}`,
      `L ${midX} ${sourcePos.y}`,
      `L ${midX} ${rightEdgeCenter.y}`,
      `L ${rightEdgeCenter.x} ${rightEdgeCenter.y}`
    ].join(' ')
  }
  if (decision.allow && decision.direction === 'left') {
    const leftEdgeCenter = { x: hoverTargetBox.x, y: centerY }
    const boxesLeft = Math.min(srcBox.x, hoverTargetBox.x)
    const minLeft = Math.min(sourcePos.x, leftEdgeCenter.x) - FIXED_LEAD_LENGTH
    const midX = Math.min(boxesLeft - safeClear, minLeft)
    const hasObs = hasObstacleInPath(midX, sourcePos.y, leftEdgeCenter.y, availableNodes, [sourceNode.id])
    if (hasObs) { return null }
    return [
      `M ${sourcePos.x} ${sourcePos.y}`,
      `L ${midX} ${sourcePos.y}`,
      `L ${midX} ${leftEdgeCenter.y}`,
      `L ${leftEdgeCenter.x} ${leftEdgeCenter.y}`
    ].join(' ')
  }
  return null
}

/**
 * Generate connection path with proper port positioning based on node variants
 */
export function generateVariantAwareConnectionPath(
  sourceNode: WorkflowNode,
  sourcePortId: string,
  targetNode: WorkflowNode,
  targetPortId: string,
  variant: NodeVariant = 'standard',
  config?: PathConfig
): string {
  // Determine port types including virtual side-ports
  const isSourceBottomPort = isBottomPort(sourceNode, sourcePortId) || sourcePortId === '__side-bottom'
  const isTargetBottomPort = isBottomPort(targetNode, targetPortId) || targetPortId === '__side-bottom'
  const sourcePortType = isSourceBottomPort ? 'bottom' : 'output'
  const targetPortType = isTargetBottomPort ? 'bottom' : 'input'

  // Calculate port positions (use side-port anchors when applicable)
  const sourcePos = isVirtualSidePortId(sourcePortId)
    ? getVirtualSidePortPosition(sourceNode, sourcePortId)
    : calculatePortPositionCore(sourceNode, sourcePortId, sourcePortType, variant)
  const targetPos = isVirtualSidePortId(targetPortId)
    ? getVirtualSidePortPosition(targetNode, targetPortId)
    : calculatePortPositionCore(targetNode, targetPortId, targetPortType, variant)

  // Validate positions
  if (!validatePathInputs(sourcePos, targetPos)) {
    console.warn('Invalid port positions detected, using fallback')
    return `M ${sourceNode.x + 100} ${sourceNode.y} L ${targetNode.x - 100} ${targetNode.y}`
  }

  // Determine connection flow
  const flow = getConnectionFlow(isSourceBottomPort)

  // Generate optimized path
  return generateConnectionPath(sourcePos, targetPos, flow, config)
}

/**
 * Find nearby snap targets using same logic as final connection path
 * This ensures preview path matches final path behavior
 */
function findNearbySnapTargets(
  mousePos: { x: number; y: number },
  availableNodes: WorkflowNode[],
  sourceNode: WorkflowNode,
  sourcePos: PortPosition,
  snapDistance: number = 50
): { x: number; y: number; type: 'port' | 'edge'; targetNode: WorkflowNode; targetSide: SidePortId } | null {
  const candidates: Array<{
    x: number;
    y: number;
    type: 'port' | 'edge';
    distance: number;
    targetNode: WorkflowNode;
    targetSide: SidePortId;
  }> = []

  for (const node of availableNodes) {
    if (node.id === sourceNode.id) { continue } // Skip source node

    const nodeDistance = Math.sqrt(
      Math.pow(mousePos.x - node.x, 2) + Math.pow(mousePos.y - node.y, 2)
    )
    if (nodeDistance > snapDistance * 2) { continue } // Skip distant nodes for performance

    // Use same target side selection logic as final connection
    const optimalTargetSide = chooseAutoTargetSide(sourcePos, node)
    const optimalTargetPos = getVirtualSidePortPositionForMode(node, optimalTargetSide, 'architecture')

    const targetDistance = Math.sqrt(
      Math.pow(mousePos.x - optimalTargetPos.x, 2) + Math.pow(mousePos.y - optimalTargetPos.y, 2)
    )

    if (targetDistance <= snapDistance) {
      candidates.push({
        x: optimalTargetPos.x,
        y: optimalTargetPos.y,
        type: 'edge',
        distance: targetDistance,
        targetNode: node,
        targetSide: optimalTargetSide
      })
    }
  }

  // Return the closest candidate using optimal target side selection
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.distance - b.distance)
    return candidates[0]
  }

  return null
}

/**
 * Calculate port position during connection preview
 */
export function calculateConnectionPreviewPath(
  sourceNode: WorkflowNode,
  sourcePortId: string,
  previewPosition: { x: number; y: number },
  opts?: {
    variant?: NodeVariant
    config?: PathConfig
    modeId?: string
    hoverTargetBox?: { x: number; y: number; width: number; height: number }
    // When hovering an actual node, use it to generate the exact same path as final
    hoveredNode?: WorkflowNode
    availableNodes?: WorkflowNode[]
  }
): string { // NOSONAR: readability prioritized over cognitive complexity metric here
  // Helpers extracted to reduce complexity
  // Architecture markers use size=10 (see marker-utils); half is 5px
  const HALF_MARKER = 5

  const variant: NodeVariant = opts?.variant ?? 'standard'
  const config: PathConfig | undefined = opts?.config
  const modeId: string = opts?.modeId ?? 'workflow'
  const hoverTargetBox = opts?.hoverTargetBox
  const availableNodes = opts?.availableNodes

  const isSourceBottomPort = isBottomPort(sourceNode, sourcePortId) || sourcePortId === '__side-bottom'
  const portType = isSourceBottomPort ? 'bottom' : 'output'

  // Mode-aware port position for accurate endpoint alignment
  const sourcePos: PortPosition = computeSourcePosForPreview(sourceNode, sourcePortId, portType, variant, modeId)

  // Validate positions
  if (!validatePathInputs(sourcePos, previewPosition)) {
    console.warn('Invalid preview positions detected, using fallback')
    return `M ${sourcePos.x} ${sourcePos.y} L ${previewPosition.x} ${previewPosition.y}`
  }

  // Determine connection flow
  const flow = getConnectionFlow(isSourceBottomPort) // Preview is never to a bottom port

  // Architecture mode should preview orthogonal (right‑angle) path with radius to match final rendering
  if (modeId === 'architecture') {
    const startSide = detectPortSideModeAware(sourceNode, sourcePortId, sourcePos, modeId)
    const startOrientation = sideToOrientation(startSide)
    const { previewEnd, chosenSide, endOrientation } = computeArchitecturePreviewSnapEnd({
      hoverTargetBox,
      availableNodes,
      previewPosition,
      startSide,
      isSourceBottomPort,
      sourcePos,
      sourceNode
    })

    // If hovering a node, delegate to the same generator used for final path so preview matches exactly
    if (opts?.hoveredNode && hoverTargetBox && chosenSide) {
      // Use the same horizontal U-shape decision as final for strict parity
      let sideForPreview = chosenSide
      if (startSide === 'right' || startSide === 'left') {
        const tBox: ArchBox = { x: hoverTargetBox.x, y: hoverTargetBox.y, width: hoverTargetBox.width, height: hoverTargetBox.height }
        const decision = decideHorizontalU(startSide, sourcePos, tBox)
        if (decision.allow && decision.endSide) {
          sideForPreview = decision.endSide
        } else {
          // If horizontal U is not allowed, keep chosenSide (auto) to avoid mismatch
          sideForPreview = chosenSide
        }
      }
      // Non-left/right starts: keep original bottom/top enforcement (same as final)
      if (isSourceBottomPort) {
        const targetTop = getVirtualSidePortPositionForMode(opts.hoveredNode, '__side-top', 'architecture')
        const dy = targetTop.y - sourcePos.y
        const dx = targetTop.x - sourcePos.x
        const dist = Math.hypot(dx, dy)
        if (dy > FORCE_TOP_MIN_DY && dist > FORCE_TOP_MIN_DIST) { sideForPreview = '__side-top' }
      }
      // Symmetric rule: when starting from top side and target bottom is sufficiently above source top
      if (startSide === 'top') {
        const targetBottom = getVirtualSidePortPositionForMode(opts.hoveredNode, '__side-bottom', 'architecture')
        const dyBottom = sourcePos.y - targetBottom.y
        const dxBottom = targetBottom.x - sourcePos.x
        const distBottom = Math.hypot(dxBottom, dyBottom)
        if (dyBottom > FORCE_BOTTOM_MIN_DY && distBottom > FORCE_BOTTOM_MIN_DIST) {
          sideForPreview = '__side-bottom'
        }
      }
      return generateArchitectureModeConnectionPathWithTargetSide(
        sourceNode,
        opts.hoveredNode,
        {
          sourceNodeId: sourceNode.id,
          sourcePortId,
          targetNodeId: opts.hoveredNode.id,
          // Use the decided side as the target port id during preview
          targetPortId: sideForPreview,
        },
        sideForPreview
      )
    }

    const topU = maybeTopUPathForPreview({ isSourceTopPort: sourcePortId === 'top', hoverTargetBox, previewEnd, sourceNode, sourcePos, HALF_MARKER })
    if (topU) { return topU }

    const bottomU = maybeBottomUPathForPreview({ isSourceBottomPort, hoverTargetBox, previewEnd, sourceNode, sourcePos, HALF_MARKER })
    if (bottomU) { return bottomU }

    const horizontalU = maybeHorizontalUPathForPreview({ hoverTargetBox, sourceNode, sourcePortId, sourcePos, modeId, availableNodes: opts?.availableNodes })
    if (horizontalU) { return horizontalU }

    const trimmedEndPreview = trimPointBySide(previewEnd, chosenSide, sourcePos, HALF_MARKER)
    return generateAdaptiveOrthogonalRoundedPathSmart(sourcePos, trimmedEndPreview, ARCH_CONNECTION_RADIUS, {
      clearance: 10,
      targetBox: hoverTargetBox,
      startOrientationOverride: startOrientation,
      endOrientationOverride: endOrientation
    })
  }

  // Generate curved preview path (default)
  return generatePreviewPath(sourcePos, previewPosition, flow, config)
}

/**
 * Mode-aware convenience preview path (wrapper) for callers that know only connectionStart + mouse position.
 */
export function generateModeAwarePreviewPath(
  sourceNode: WorkflowNode,
  sourcePortId: string,
  previewPosition: { x: number; y: number },
  options: {
    modeId: string
    variant?: NodeVariant
    config?: PathConfig
    hoverTargetBox?: { x: number; y: number; width: number; height: number }
    availableNodes?: WorkflowNode[]
  }
): string {
  const { modeId, variant = 'standard', config, hoverTargetBox, availableNodes } = options
  return calculateConnectionPreviewPath(sourceNode, sourcePortId, previewPosition, { variant, config, modeId, hoverTargetBox, availableNodes })
}

/**
 * Generate connection path with offset for multiple connections between same nodes
 * Architecture mode uses bundled representation while workflow mode shows individual lines
 */
export function generateMultipleConnectionPath(opts: {
  sourceNode: WorkflowNode
  sourcePortId: string
  targetNode: WorkflowNode
  targetPortId: string
  connectionIndex?: number
  totalConnections?: number
  variant?: NodeVariant
  mode?: 'workflow' | 'architecture'
  config?: PathConfig
}): string {
  const {
    sourceNode,
    sourcePortId,
    targetNode,
    targetPortId,
    connectionIndex = 0,
    totalConnections = 1,
    variant = 'standard',
    mode = 'workflow',
    config
  } = opts
  // If only one connection, use base path
  if (totalConnections <= 1) {
    return generateVariantAwareConnectionPath(sourceNode, sourcePortId, targetNode, targetPortId, variant, config)
  }

  // Validate node positions
  if (!isFinite(sourceNode.x) || !isFinite(sourceNode.y) ||
    !isFinite(targetNode.x) || !isFinite(targetNode.y)) {
    console.warn('Invalid node positions, using fallback')
    return generateVariantAwareConnectionPath(sourceNode, sourcePortId, targetNode, targetPortId, variant, config)
  }

  // Architecture mode: Use bundled connection approach
  if (mode === 'architecture') {
    // For architecture mode, use the orthogonal path generator with fixed sizing so endpoints align with ports
    return generateArchitectureModeConnectionPath(
      sourceNode,
      targetNode,
      { sourceNodeId: sourceNode.id, sourcePortId, targetNodeId: targetNode.id, targetPortId }
    )
  }

  // Workflow mode: Show individual offset lines
  // Use simplified node-edge positioning for multiple connections
  const sourcePos: PortPosition = { x: sourceNode.x + 100, y: sourceNode.y }
  const targetPos: PortPosition = { x: targetNode.x - 100, y: targetNode.y }

  // Calculate Y offset for this connection
  const yOffset = calculateConnectionOffset(connectionIndex, totalConnections)

  // Validate positions
  if (!validatePathInputs(sourcePos, targetPos)) {
    console.warn('Invalid connection positions, using fallback')
    return `M ${sourcePos.x} ${sourcePos.y} L ${targetPos.x} ${targetPos.y}`
  }

  // Generate offset path
  return generateOffsetPath(sourcePos, targetPos, yOffset, config)
}

/**
 * Mode-aware high level convenience API.
 * Accepts a Connection object + node list + mode id and returns appropriate path.
 * - workflow/debug/default => existing bezier logic
 * - architecture => orthogonal with rounded corners (Manhattan style)
 */
export function generateModeAwareConnectionPath(
  connection: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string },
  nodes: WorkflowNode[],
  variant: NodeVariant = 'standard',
  modeId: string = 'workflow',
  config?: PathConfig
): string {
  const sourceNode = nodes.find(n => n.id === connection.sourceNodeId)
  const targetNode = nodes.find(n => n.id === connection.targetNodeId)
  if (!sourceNode || !targetNode) { return '' }

  if (modeId === 'architecture') {
    return generateArchitectureModeConnectionPath(sourceNode, targetNode, connection)
  }

  // Fallback to existing bezier
  return generateVariantAwareConnectionPath(
    sourceNode,
    connection.sourcePortId,
    targetNode,
    connection.targetPortId,
    variant,
    config
  )
}

/**
 * Return mode-aware port anchors (source/target positions) for a given connection.
 * Useful for external consumers that need stable endpoints without duplicating logic.
 */
export function getModeAwarePortAnchors(
  connection: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string },
  nodes: WorkflowNode[],
  _variant: NodeVariant = 'standard',
  modeId: DesignerMode = 'workflow'
): { source: PortPosition; target: PortPosition } | null {
  const sourceNode = nodes.find(n => n.id === connection.sourceNodeId)
  const targetNode = nodes.find(n => n.id === connection.targetNodeId)
  if (!sourceNode || !targetNode) { return null }

  const isSourceBottom = isBottomPort(sourceNode, connection.sourcePortId) || connection.sourcePortId === '__side-bottom'
  const isTargetBottom = isBottomPort(targetNode, connection.targetPortId) || connection.targetPortId === '__side-bottom'
  const sourceType: PortType = isSourceBottom ? 'bottom' : 'output'
  const targetType: PortType = isTargetBottom ? 'bottom' : 'input'

  const sourcePos = getModeAwarePortPosition(sourceNode, connection.sourcePortId, sourceType, modeId)
  const targetPos = getModeAwarePortPosition(targetNode, connection.targetPortId, targetType, modeId)
  return { source: sourcePos, target: targetPos }
}

// Shared helpers for Architecture mode (avoid duplicate implementations)
type ArchBox = { x: number; y: number; width: number; height: number }
type ArchPoint = { x: number; y: number }

function createArchitectureCaches() {
  const boxCache = new Map<WorkflowNode, ArchBox>()
  const portPosCache = new WeakMap<WorkflowNode, Map<string, ArchPoint>>()
  const cachedBuildNodeBoxModeAware = (node: WorkflowNode): ArchBox => {
    const hit = boxCache.get(node)
    if (hit) { return hit }
    const box = buildNodeBoxModeAware(node, 'architecture')
    const frozen = Object.freeze({ ...box }) as ArchBox
    boxCache.set(node, frozen)
    return frozen
  }
  const cachedSidePort = (node: WorkflowNode, side: SidePortId): ArchPoint => {
    let inner = portPosCache.get(node)
    if (!inner) { inner = new Map<string, ArchPoint>(); portPosCache.set(node, inner) }
    const key = `${side}|architecture`
    const hit = inner.get(key)
    if (hit) { return hit }
    const pos = getVirtualSidePortPositionForMode(node, side, 'architecture')
    const frozen = Object.freeze({ ...pos }) as ArchPoint
    inner.set(key, frozen)
    return frozen
  }
  return { cachedBuildNodeBoxModeAware, cachedSidePort }
}

// Shared horizontal U-shape decision for Left/Right to keep parity with Top/Bottom rules
type HorizontalUDecision = { allow: boolean; endSide?: '__side-left' | '__side-right'; direction?: 'left' | 'right' }
function decideHorizontalU(startSide: PortSide, sourcePos: PortPosition, tBox: ArchBox): HorizontalUDecision {
  if (startSide !== 'left' && startSide !== 'right') { return { allow: false } }
  const centerY = tBox.y + tBox.height / 2
  const tgtCenterX = tBox.x + tBox.width / 2
  const dy = centerY - sourcePos.y
  const TH = U_SHAPE_CONFIG.PROXIMITY_THRESHOLD
  const EXT = TH * 3
  if (startSide === 'right') {
    const dxCenter = tgtCenterX - sourcePos.x
    const dxRightEdge = (tBox.x + tBox.width) - sourcePos.x
    const allowStandard = dxCenter > 0 && dxCenter < TH
    const allowFallback = Math.abs(dxRightEdge) < EXT && Math.abs(dy) > U_SHAPE_CONFIG.SAFE_CLEARANCE
    return { allow: allowStandard || allowFallback, endSide: '__side-right', direction: 'right' }
  } else {
    const dxCenter = sourcePos.x - tgtCenterX
    const dxLeftEdge = sourcePos.x - tBox.x
    const allowStandard = dxCenter > 0 && dxCenter < TH
    const allowFallback = Math.abs(dxLeftEdge) < EXT && Math.abs(dy) > U_SHAPE_CONFIG.SAFE_CLEARANCE
    return { allow: allowStandard || allowFallback, endSide: '__side-left', direction: 'left' }
  }
}

function computeArchPortPos(
  node: WorkflowNode,
  portId: string,
  portType: PortType,
  dims: { width: number; height: number }
): PortPosition {
  if (isVirtualSidePortId(portId)) { return getVirtualSidePortPositionForMode(node, portId, 'architecture') }
  if (portType === 'bottom') {
    const ports = node.bottomPorts || []
    const idx = Math.max(0, ports.findIndex(p => p.id === portId))
    const count = ports.length
    const usableWidth = Math.min(dims.width * 0.8, dims.width - 70)
    if (count === 2) {
      const spacing = usableWidth / 3; const positions = [-spacing, spacing]
      return { x: node.x + (positions[idx] || 0), y: node.y + dims.height / 2 }
    }
    if (count === 3) {
      const half = usableWidth / 2; const positions = [-half, 0, half]
      return { x: node.x + (positions[idx] || 0), y: node.y + dims.height / 2 }
    }
    if (count >= 4) {
      const spacing = usableWidth / (count - 1)
      const relX = -usableWidth / 2 + spacing * idx
      return { x: node.x + relX, y: node.y + dims.height / 2 }
    }
    return { x: node.x, y: node.y + dims.height / 2 }
  }
  const ports = portType === 'input' ? node.inputs : node.outputs
  const idx = Math.max(0, ports.findIndex(p => p.id === portId))
  const count = ports.length || 1
  const spacing = dims.height / (count + 1)
  const y = -dims.height / 2 + spacing * (idx + 1)
  const x = portType === 'input' ? -dims.width / 2 : dims.width / 2
  return { x: node.x + x, y: node.y + y }
}

function buildHorizontalU(params: {
  direction: 'left' | 'right'
  startSide: 'left' | 'right' | 'top' | 'bottom' | 'unknown'
  targetSidePortId: SidePortId
  sourcePos: PortPosition
  sourceNode: WorkflowNode
  targetNode: WorkflowNode
  HALF_MARKER: number
  forcedPos: ArchPoint
  trimSide: '__side-left' | '__side-right'
  cachedBuildNodeBoxModeAware: (n: WorkflowNode) => ArchBox
}): string | null {
  const { direction, startSide, targetSidePortId, sourcePos, sourceNode, targetNode, HALF_MARKER, forcedPos, trimSide, cachedBuildNodeBoxModeAware } = params
  if (direction === 'right') {
    if (startSide !== 'right' || targetSidePortId !== '__side-right') { return null }
    // Allow U-shape regardless of dx to keep behavior consistent across distances
    const srcBox = cachedBuildNodeBoxModeAware(sourceNode)
    const tgtBox = cachedBuildNodeBoxModeAware(targetNode)
    const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
    const boxesRight = Math.max(srcBox.x + srcBox.width, tgtBox.x + tgtBox.width)
    const minRight = Math.max(sourcePos.x, forcedPos.x) + FIXED_LEAD_LENGTH
    const midX = Math.max(boxesRight + safeClear, minRight)
    const rightAligned = { x: forcedPos.x, y: forcedPos.y }
    const trimmedEnd = trimPointBySide(rightAligned, trimSide, sourcePos, HALF_MARKER)
    const points = [
      { x: sourcePos.x, y: sourcePos.y },
      { x: midX, y: sourcePos.y },
      { x: midX, y: trimmedEnd.y },
      { x: trimmedEnd.x, y: trimmedEnd.y }
    ]
    return buildRoundedPathFromPoints(points, ARCH_CONNECTION_RADIUS)
  } else {
    if (startSide !== 'left' || targetSidePortId !== '__side-left') { return null }
    // Use distance to the target's center/port instead of box edge and ensure target is left
    // Allow U-shape regardless of dx to keep behavior consistent across distances
    const srcBox = cachedBuildNodeBoxModeAware(sourceNode)
    const tgtBox = cachedBuildNodeBoxModeAware(targetNode)
    const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
    const boxesLeft = Math.min(srcBox.x, tgtBox.x)
    const minLeft = Math.min(sourcePos.x, forcedPos.x) - FIXED_LEAD_LENGTH
    const midX = Math.min(boxesLeft - safeClear, minLeft)
    const leftAligned = { x: forcedPos.x, y: forcedPos.y }
    const trimmedEnd = trimPointBySide(leftAligned, trimSide, sourcePos, HALF_MARKER)
    const points = [
      { x: sourcePos.x, y: sourcePos.y },
      { x: midX, y: sourcePos.y },
      { x: midX, y: trimmedEnd.y },
      { x: trimmedEnd.x, y: trimmedEnd.y }
    ]
    return buildRoundedPathFromPoints(points, ARCH_CONNECTION_RADIUS)
  }
}

// Extracted to reduce cognitive complexity of generateModeAwareConnectionPath
// Core generator shared by architecture-mode path functions
function generateArchitecturePathCore(
  sourceNode: WorkflowNode,
  targetNode: WorkflowNode,
  connection: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string },
  explicitTargetSide?: SidePortId
): string {
  const { cachedBuildNodeBoxModeAware, cachedSidePort } = createArchitectureCaches()

  const isSourceBottom = isBottomPort(sourceNode, connection.sourcePortId) || connection.sourcePortId === '__side-bottom'
  const isTargetBottom = isBottomPort(targetNode, connection.targetPortId) || connection.targetPortId === '__side-bottom'

  // For architecture mode, also consider connections starting from bottom area as "bottom" connections
  const isArchModeSourceBottom = isSourceBottom || connection.sourcePortId === '__side-bottom'

  // Use architecture-aware bottom detection for subsequent logic
  const effectiveIsSourceBottom = isArchModeSourceBottom
  const sourceType = effectiveIsSourceBottom ? 'bottom' : 'output'
  const targetType = isTargetBottom ? 'bottom' : 'input'
  const sourceDims = getModeAwareDimensions(sourceNode, 'architecture')
  const targetDims = getModeAwareDimensions(targetNode, 'architecture')

  const sourcePos = computeArchPortPos(sourceNode, connection.sourcePortId, sourceType, sourceDims)
  const targetPos = computeArchPortPos(targetNode, connection.targetPortId, targetType, targetDims)
  if (!validatePathInputs(sourcePos, targetPos)) { return '' }

  const startSide = detectPortSideModeAware(sourceNode, connection.sourcePortId, sourcePos, 'architecture')
  const startOrientation = sideToOrientation(startSide)

  const applyEnforcement = (initialSide?: SidePortId): SidePortId | undefined => {
    // Top enforcement for bottom-start
    if (effectiveIsSourceBottom) {
      const targetTop = getVirtualSidePortPositionForMode(targetNode, '__side-top', 'architecture')
      const dy = targetTop.y - sourcePos.y
      const dx = targetTop.x - sourcePos.x
      const dist = Math.hypot(dx, dy)
      if (dy > FORCE_TOP_MIN_DY && dist > FORCE_TOP_MIN_DIST) { return '__side-top' }
      // NEW: If a horizontal side (left/right) was explicitly requested while starting from bottom,
      // coerce it to a vertical side (bottom/top) using the same proximity heuristic as the
      // bottom-start branch below. This preserves U-shape intent near targets even with sticky-side overrides.
      if (initialSide === '__side-left' || initialSide === '__side-right') {
        const tBox = cachedBuildNodeBoxModeAware(targetNode)
        const useBottom = (tBox.y - sourcePos.y) < FIXED_LEAD_LENGTH * 3 // 150px
        return useBottom ? '__side-bottom' : '__side-top'
      }
    }
    // Bottom enforcement for top-start
    if (startSide === 'top') {
      const targetBottom = getVirtualSidePortPositionForMode(targetNode, '__side-bottom', 'architecture')
      const dyBottom = sourcePos.y - targetBottom.y
      const dxBottom = targetBottom.x - sourcePos.x
      const distBottom = Math.hypot(dxBottom, dyBottom)
      if (dyBottom > FORCE_BOTTOM_MIN_DY && distBottom > FORCE_BOTTOM_MIN_DIST) { return '__side-bottom' }
    }
    return initialSide
  }

  const chooseTargetSide = (): SidePortId => {
    // Priority 1 - If explicit side provided, honor it (with possible enforcement)
    if (explicitTargetSide) {
      return applyEnforcement(explicitTargetSide) || explicitTargetSide
    }

    // Priority 2 - Symmetric horizontal U-shape heuristic; reuse shared decision logic for parity
    if (startSide === 'right' || startSide === 'left') {
      const tBox = cachedBuildNodeBoxModeAware(targetNode)
      const decision = decideHorizontalU(startSide, sourcePos, tBox)
      if (decision.allow && decision.endSide) { return decision.endSide }
    }

    // Priority 3 - Enforcement for top/bottom clarity when applicable
    const enforced = applyEnforcement()
    if (enforced) { return enforced }

    // Bottom-start snap heuristic
    if (effectiveIsSourceBottom) {
      // More generous threshold for bottom-to-bottom U-shape routing
      // Original: FIXED_LEAD_LENGTH * 2 (100px) might be too restrictive
      const SNAP_THRESHOLD = FIXED_LEAD_LENGTH * 3 // 150px for better bottom-to-bottom detection
      const tBox = cachedBuildNodeBoxModeAware(targetNode)
      const useBottom = (tBox.y - sourcePos.y) < SNAP_THRESHOLD

      return useBottom ? '__side-bottom' : '__side-top'
    }    // Enhanced bottom-to-bottom detection for architecture mode
    // Check if nodes are horizontally close and vertically aligned for better U-shape routing
    const srcBox = cachedBuildNodeBoxModeAware(sourceNode)
    const tgtBox = cachedBuildNodeBoxModeAware(targetNode)
    const horizontalDistance = Math.abs(srcBox.x - tgtBox.x)
    const verticalDistance = Math.abs(srcBox.y - tgtBox.y)

    // If nodes are close horizontally and relatively aligned vertically, prefer bottom-to-bottom
    if (horizontalDistance < FIXED_LEAD_LENGTH * 2 && verticalDistance < FIXED_LEAD_LENGTH) {
      return '__side-bottom'
    }

    // Special case: If source is __side-bottom and nodes are reasonably close, force bottom-to-bottom
    if (connection.sourcePortId === '__side-bottom') {
      const reasonableDistance = FIXED_LEAD_LENGTH * 3 // 150px
      if (horizontalDistance < reasonableDistance) {
        return '__side-bottom'
      }
    }

    // If target port is already a side port, use it; otherwise auto-pick
    if (isVirtualSidePortId(connection.targetPortId)) {
      const tp = connection.targetPortId
      return (tp === '__side-left' || tp === '__side-right' || tp === '__side-top' || tp === '__side-bottom')
        ? tp
        : chooseAutoTargetSide(sourcePos, targetNode)
    }
    return chooseAutoTargetSide(sourcePos, targetNode)
  }

  const targetSidePortId = chooseTargetSide()
  const sideAnchor = getVirtualSidePortPositionForMode(targetNode, targetSidePortId, 'architecture')
  const preciseEnd: { x: number; y: number } = ((): { x: number; y: number } => {
    switch (targetSidePortId) {
      case '__side-left':
      case '__side-right':
        return { x: sideAnchor.x, y: sideAnchor.y }
      case '__side-top':
      case '__side-bottom':
      default: {
        const isActualBottomTarget = isTargetBottom
        const endX = isActualBottomTarget ? targetPos.x : sideAnchor.x
        return { x: endX, y: sideAnchor.y }
      }
    }
  })()
  const endOrientation = sideToOrientation(detectPortSideModeAware(targetNode, targetSidePortId, preciseEnd, 'architecture'))

  const HALF_MARKER = U_SHAPE_CONFIG.MARKER_TRIM
  const trimmedEnd = trimPointBySide(preciseEnd, targetSidePortId, sourcePos, HALF_MARKER)

  // Bottom U-shape special-case
  if (effectiveIsSourceBottom && targetSidePortId === '__side-bottom') {
    const srcBox = cachedBuildNodeBoxModeAware(sourceNode)
    const tgtBox = cachedBuildNodeBoxModeAware(targetNode)
    const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
    const boxesBottom = Math.max(srcBox.y + srcBox.height, tgtBox.y + tgtBox.height)
    const minBelow = Math.max(sourcePos.y, preciseEnd.y) + FIXED_LEAD_LENGTH
    const midY = Math.max(boxesBottom + safeClear, minBelow)
    const bottomUTrimmedEnd = trimPointBySide(preciseEnd, '__side-bottom', sourcePos, HALF_MARKER)

    const points = [
      { x: sourcePos.x, y: sourcePos.y },
      { x: sourcePos.x, y: midY },
      { x: bottomUTrimmedEnd.x, y: midY },
      { x: bottomUTrimmedEnd.x, y: bottomUTrimmedEnd.y }
    ]
    return buildRoundedPathFromPoints(points, ARCH_CONNECTION_RADIUS)
  }  // Top U-shape special-case (symmetric to bottom U-shape)
  const isSourceTop = startSide === 'top' || connection.sourcePortId === '__side-top'
  if (isSourceTop && targetSidePortId === '__side-top') {
    const srcBox = cachedBuildNodeBoxModeAware(sourceNode)
    const tgtBox = cachedBuildNodeBoxModeAware(targetNode)
    const safeClear = U_SHAPE_CONFIG.SAFE_CLEARANCE
    const boxesTop = Math.min(srcBox.y, tgtBox.y)
    const minAbove = Math.min(sourcePos.y, preciseEnd.y) - FIXED_LEAD_LENGTH
    const midY = Math.min(boxesTop - safeClear, minAbove)
    const topUTrimmedEnd = trimPointBySide(preciseEnd, '__side-top', sourcePos, HALF_MARKER)
    const points = [
      { x: sourcePos.x, y: sourcePos.y },
      { x: sourcePos.x, y: midY },
      { x: topUTrimmedEnd.x, y: midY },
      { x: topUTrimmedEnd.x, y: topUTrimmedEnd.y }
    ]
    return buildRoundedPathFromPoints(points, ARCH_CONNECTION_RADIUS)
  }

  // Horizontal U-shapes for close proximity
  const rightU = buildHorizontalU({
    direction: 'right',
    startSide,
    targetSidePortId,
    sourcePos,
    sourceNode,
    targetNode,
    HALF_MARKER,
    forcedPos: cachedSidePort(targetNode, '__side-right'),
    trimSide: '__side-right',
    cachedBuildNodeBoxModeAware
  }); if (rightU) { return rightU }

  const leftU = buildHorizontalU({
    direction: 'left',
    startSide,
    targetSidePortId,
    sourcePos,
    sourceNode,
    targetNode,
    HALF_MARKER,
    forcedPos: cachedSidePort(targetNode, '__side-left'),
    trimSide: '__side-left',
    cachedBuildNodeBoxModeAware
  }); if (leftU) { return leftU }

  return generateAdaptiveOrthogonalRoundedPathSmart(sourcePos, trimmedEnd, ARCH_CONNECTION_RADIUS, {
    clearance: 10,
    targetBox: cachedBuildNodeBoxModeAware(targetNode),
    startOrientationOverride: startOrientation,
    endOrientationOverride: endOrientation
  })
}

// Thin wrapper preserving public API
function generateArchitectureModeConnectionPath(
  sourceNode: WorkflowNode,
  targetNode: WorkflowNode,
  connection: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string }
): string {
  return generateArchitecturePathCore(sourceNode, targetNode, connection)
}

/**
 * Architecture path generator with explicit target side override.
 * This is used by hooks to implement "sticky side" with hysteresis to avoid one-frame jumps.
 */
export function generateArchitectureModeConnectionPathWithTargetSide(
  sourceNode: WorkflowNode,
  targetNode: WorkflowNode,
  connection: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string },
  targetSidePortId: SidePortId
): string {
  return generateArchitecturePathCore(sourceNode, targetNode, connection, targetSidePortId)
}

/**
 * Analyze connections to detect multiple connections between same node pairs
 */
export function analyzeConnectionGroups(connections: Array<{
  id: string
  sourceNodeId: string
  targetNodeId: string
  sourcePortId: string
  targetPortId: string
}>): Map<string, Array<{
  id: string
  sourceNodeId: string
  targetNodeId: string
  sourcePortId: string
  targetPortId: string
  index: number
  total: number
}>> {
  return analyzeConnectionGroupsCore(connections)
}

/**
 * Get connection group information for a specific connection
 */
export function getConnectionGroupInfo(
  connectionId: string,
  connections: Array<{
    id: string
    sourceNodeId: string
    targetNodeId: string
    sourcePortId: string
    targetPortId: string
  }>
): { index: number; total: number; isMultiple: boolean } {
  const groupInfo = getConnectionGroupInfoCore(connectionId, connections)
  return {
    index: groupInfo.index,
    total: groupInfo.total,
    isMultiple: groupInfo.isMultiple
  }
}

/**
 * New grouping for multi-connection paths by side and port-group
 * - Group by side: __side-left, __side-right, __side-top, __side-bottom (per endpoint)
 * - Group by port-group: 'output-port-group' | 'input-port-group' (per endpoint)
 */
export type PortGroupClass = 'output-port-group' | 'input-port-group'
export type SideGroupId = '__side-left' | '__side-right' | '__side-top' | '__side-bottom'

function toSideGroupId(side: 'left' | 'right' | 'top' | 'bottom' | 'unknown'): SideGroupId {
  if (side === 'left') { return '__side-left' }
  if (side === 'right') { return '__side-right' }
  if (side === 'top') { return '__side-top' }
  // fallback unknown->bottom for stability
  return '__side-bottom'
}

function resolvePortTypeForEnd(
  node: WorkflowNode,
  portId: string,
  isSourceEnd: boolean
): PortType {
  if (isBottomPort(node, portId)) { return 'bottom' }
  const t = getPortType(node, portId)
  if (t === 'input' || t === 'output') { return t }
  // Default: source tends to be output, target tends to be input
  return isSourceEnd ? 'output' : 'input'
}

function getModeAwarePortPosition(
  node: WorkflowNode,
  portId: string,
  portType: PortType,
  modeId: DesignerMode
): PortPosition { // NOSONAR: structured branching for clarity
  if (modeId === 'architecture') {
    const dims = getModeAwareDimensions(node, 'architecture')
    return computeArchPortPos(node, portId, portType, dims)
  }
  // workflow/default
  const variant: NodeVariant = 'standard'
  if (isVirtualSidePortId(portId)) {
    return getVirtualSidePortPosition(node, portId)
  }
  const t: PortType = portType === 'bottom' ? 'bottom' : portType
  return calculatePortPositionCore(node, portId, t, variant)
}

export function groupConnectionsBySideAndPort(
  connections: Array<{
    id: string
    sourceNodeId: string
    targetNodeId: string
    sourcePortId: string
    targetPortId: string
  }>,
  nodes: WorkflowNode[],
  modeId: DesignerMode = 'architecture'
): Map<string, {
  key: string
  sourceSide: SideGroupId
  targetSide: SideGroupId
  sourceGroup: PortGroupClass
  targetGroup: PortGroupClass
  items: Array<{ id: string; sourceNodeId: string; targetNodeId: string; sourcePortId: string; targetPortId: string }>
}> {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  type GroupBucket = {
    key: string
    sourceSide: SideGroupId
    targetSide: SideGroupId
    sourceGroup: PortGroupClass
    targetGroup: PortGroupClass
    items: Array<{ id: string; sourceNodeId: string; targetNodeId: string; sourcePortId: string; targetPortId: string }>
  }
  const result = new Map<string, GroupBucket>()

  for (const c of connections) {
    const sNode = nodeMap.get(c.sourceNodeId)
    const tNode = nodeMap.get(c.targetNodeId)
    if (!sNode || !tNode) { continue }

    const sType = resolvePortTypeForEnd(sNode, c.sourcePortId, true)
    const tType = resolvePortTypeForEnd(tNode, c.targetPortId, false)

    // Compute sides in a way that mirrors the architecture path generator
    let sSide: SideGroupId
    let tSide: SideGroupId
    if (modeId === 'architecture') {
      // Source side based on actual source port position in architecture sizing
      const sPosArch = getModeAwarePortPosition(sNode, c.sourcePortId, sType, 'architecture')
      sSide = toSideGroupId(detectPortSideModeAware(sNode, c.sourcePortId, sPosArch, 'architecture'))

      // Target side follows the same chooseTargetSide logic as path generation
      const isSourceBottom = isBottomPort(sNode, c.sourcePortId) || c.sourcePortId === '__side-bottom'
      const chooseTargetSideForGroup = (): SidePortId => {
        // Mirror conditional top preference for all targets in grouping
        const isSourceBottomLocal = isBottomPort(sNode, c.sourcePortId) || c.sourcePortId === '__side-bottom'
        if (isSourceBottomLocal) {
          const sPos = getModeAwarePortPosition(sNode, c.sourcePortId, sType, 'architecture')
          const targetTop = getVirtualSidePortPositionForMode(tNode, '__side-top', 'architecture')
          const dy = targetTop.y - sPos.y
          const dx = targetTop.x - sPos.x
          const dist = Math.hypot(dx, dy)
          if (dy > FORCE_TOP_MIN_DY && dist > FORCE_TOP_MIN_DIST) { return '__side-top' }
        }
        // Mirror symmetric bottom preference when the start side is top
        const sPosForTop = getModeAwarePortPosition(sNode, c.sourcePortId, sType, 'architecture')
        const startSideLocal = detectPortSideModeAware(sNode, c.sourcePortId, sPosForTop, 'architecture')
        if (startSideLocal === 'top') {
          const targetBottom = getVirtualSidePortPositionForMode(tNode, '__side-bottom', 'architecture')
          const dyBottom = sPosForTop.y - targetBottom.y
          const dxBottom = targetBottom.x - sPosForTop.x
          const distBottom = Math.hypot(dxBottom, dyBottom)
          if (dyBottom > FORCE_BOTTOM_MIN_DY && distBottom > FORCE_BOTTOM_MIN_DIST) { return '__side-bottom' }
        }
        if (isSourceBottom) {
          const SNAP_THRESHOLD = FIXED_LEAD_LENGTH * 2
          const tBox = buildNodeBoxModeAware(tNode, 'architecture')
          const useBottom = (tBox.y - sPosArch.y) < SNAP_THRESHOLD
          return useBottom ? '__side-bottom' : '__side-top'
        }
        if (isVirtualSidePortId(c.targetPortId)) {
          const tp = c.targetPortId
          return (tp === '__side-left' || tp === '__side-right' || tp === '__side-top' || tp === '__side-bottom')
            ? tp
            : chooseAutoTargetSide(sPosArch, tNode)
        }
        return chooseAutoTargetSide(sPosArch, tNode)
      }
      tSide = chooseTargetSideForGroup() as SideGroupId
    } else {
      // Workflow/other modes: fallback to port-edge side detection
      const sPos = getModeAwarePortPosition(sNode, c.sourcePortId, sType, modeId)
      const tPos = getModeAwarePortPosition(tNode, c.targetPortId, tType, modeId)
      sSide = toSideGroupId(detectPortSideModeAware(sNode, c.sourcePortId, sPos, modeId || 'workflow'))
      tSide = toSideGroupId(detectPortSideModeAware(tNode, c.targetPortId, tPos, modeId || 'workflow'))
    }

    const sGroup: PortGroupClass = (sType === 'input') ? 'input-port-group' : 'output-port-group'
    const tGroup: PortGroupClass = (tType === 'output') ? 'output-port-group' : 'input-port-group'

    // Architecture grouping key is route-based: same visual route => same key
    const key = (modeId === 'architecture')
      ? `${c.sourceNodeId}|${sSide}->${c.targetNodeId}|${tSide}`
      // Other modes: keep existing detailed key
      : `${c.sourceNodeId}|${sSide}:${sGroup}->${c.targetNodeId}|${tSide}:${tGroup}`
    let bucket = result.get(key)
    if (!bucket) {
      bucket = { key, sourceSide: sSide, targetSide: tSide, sourceGroup: sGroup, targetGroup: tGroup, items: [] }
      result.set(key, bucket)
    }
    bucket.items.push({ id: c.id, sourceNodeId: c.sourceNodeId, targetNodeId: c.targetNodeId, sourcePortId: c.sourcePortId, targetPortId: c.targetPortId })
  }

  return result
}

/**
 * Check if a node is a legacy endpoint based on various criteria
 * @deprecated This function may no longer be needed - consider removing
 */
export function isLegacyEndpoint(node: WorkflowNode): boolean {
  return (
    node.config?.isLegacyEndpoint ||
    node.type?.includes('legacy') ||
    (node.inputs && node.inputs.length > 3) ||
    (node.outputs && node.outputs.length > 3) ||
    node.metadata?.category?.includes('Legacy') ||
    false
  )
}

// Additional utility functions for better API

/**
 * Validates that all required parameters are present for path generation
 */
export function validateConnectionParameters(
  sourceNode: WorkflowNode,
  sourcePortId: string,
  targetNode: WorkflowNode,
  targetPortId: string
): { valid: boolean; reason?: string } {
  if (!sourceNode || !targetNode) {
    return { valid: false, reason: 'Missing source or target node' }
  }

  if (!sourcePortId || !targetPortId) {
    return { valid: false, reason: 'Missing port IDs' }
  }

  if (!validatePortExists(sourceNode, sourcePortId, getPortType(sourceNode, sourcePortId) || 'output')) {
    return { valid: false, reason: `Source port ${sourcePortId} not found` }
  }

  if (!validatePortExists(targetNode, targetPortId, getPortType(targetNode, targetPortId) || 'input')) {
    return { valid: false, reason: `Target port ${targetPortId} not found` }
  }

  return { valid: true }
}

/**
 * Creates a high-performance path generator with memoization
 */
export function createOptimizedPathGenerator(config?: PathConfig) {
  const cache = new Map<string, string>()

  return {
    generatePath(
      sourceNode: WorkflowNode,
      sourcePortId: string,
      targetNode: WorkflowNode,
      targetPortId: string,
      variant: NodeVariant = 'standard'
    ): string {
      const cacheKey = `${sourceNode.id}:${sourcePortId}->${targetNode.id}:${targetPortId}:${variant}`

      if (cache.has(cacheKey)) {
        return cache.get(cacheKey)!
      }

      const path = generateVariantAwareConnectionPath(
        sourceNode, sourcePortId, targetNode, targetPortId, variant, config
      )

      cache.set(cacheKey, path)
      return path
    },

    clearCache() {
      cache.clear()
    },

    getCacheSize() {
      return cache.size
    }
  }
}

// ======================== CONNECTION RENDERING HELPERS ========================
// Helper functions for connection preview and port state management
// (Previously in connection-rendering-helpers.ts)

// Port datum interfaces for better typing
interface PortDatum {
  nodeId: string;
  id: string;
  nodeData: WorkflowNode;
}

interface SidePortDatum {
  kind: 'input' | 'output';
}

interface NodeDimensions {
  width: number;
  height: number;
  portRadius?: number;
}

// Helper to compute hover target box for connection preview
const computeHoverTargetBox = (
  node: WorkflowNode | undefined,
  getDims: (n: WorkflowNode) => NodeDimensions
): { x: number; y: number; width: number; height: number } | undefined => {
  if (!node) {
    return undefined;
  }
  const dims = getDims(node);
  const w = dims.width || NODE_WIDTH;
  const h = dims.height || NODE_MIN_HEIGHT;
  return { x: node.x - w / 2, y: node.y - h / 2, width: w, height: h };
};

/**
 * Render connection preview path during drag
 */
export function renderConnectionPreviewPath(
  targetLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
  params: {
    isConnecting: boolean;
    connectionStart: { nodeId: string; portId: string; type: 'input' | 'output' } | null;
    connectionPreview: { x: number; y: number } | null;
    nodes: WorkflowNode[];
    nodeMap: Map<string, WorkflowNode>;
    nodeVariant: NodeVariant;
    modeId: DesignerMode;
    getDims: (n: WorkflowNode) => NodeDimensions;
    getArrowMarkerForMode: (isWorkflowMode: boolean, state: MarkerState) => string;
    dbg: { warn: (...args: unknown[]) => void };
  }
) {
  const {
    isConnecting,
    connectionStart,
    connectionPreview,
    nodes,
    nodeMap,
    nodeVariant,
    modeId,
    getDims,
    getArrowMarkerForMode,
    dbg,
  } = params;

  // Upsert a single preview path element to avoid per-frame remove/append churn
  const ensurePreviewPath = () => {
    let sel = targetLayer.select<SVGPathElement>('path.connection-preview');
    if (sel.empty()) {
      sel = targetLayer
        .append('path')
        .attr('class', 'connection-preview')
        .attr('stroke', '#2196F3')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '5,5')
        .attr('stroke-linecap', 'round')
        .attr('fill', 'none')
        .attr('pointer-events', 'none')
        .style('opacity', 0.7);
    }
    return sel;
  };

  // If not connecting or missing preview, remove existing and exit
  if (!(isConnecting && connectionStart && connectionPreview)) {
    targetLayer.selectAll('.connection-preview').remove();
    return;
  }

  const sourceNode = nodeMap.get(connectionStart.nodeId);
  if (!sourceNode) {
    dbg.warn('🔄 Effect not rendering preview: missing sourceNode');
    return;
  }

  const hoveredNode = nodes.find((n) => {
    const dims = getDims(n);
    const w = dims.width || NODE_WIDTH;
    const h = dims.height || NODE_MIN_HEIGHT;
    return (
      connectionPreview.x >= n.x - w / 2 &&
      connectionPreview.x <= n.x + w / 2 &&
      connectionPreview.y >= n.y - h / 2 &&
      connectionPreview.y <= n.y + h / 2
    );
  });

  const hoverTargetBox = computeHoverTargetBox(hoveredNode, getDims);

  const previewPath = calculateConnectionPreviewPath(
    sourceNode,
    connectionStart.portId,
    connectionPreview,
    {
      variant: nodeVariant,
      modeId: modeId || 'workflow',
      hoverTargetBox,
      hoveredNode,
    }
  );

  const isWorkflowMode = modeId === 'workflow';
  const previewMarker = getArrowMarkerForMode(isWorkflowMode, 'default');
  const pathSel = ensurePreviewPath();
  pathSel
    .attr('d', previewPath)
    .attr('marker-end', previewMarker);
}

/**
 * Tag side ports during connection for architecture mode
 */
export function tagSidePortsDuringConnection(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  params: {
    modeId: DesignerMode;
    isConnecting: boolean;
    connectionStart: { type: 'input' | 'output' } | null;
  }
) {
  const { modeId, isConnecting, connectionStart } = params;
  if (modeId !== 'architecture') {
    return;
  }

  const sidePorts = svg.selectAll<SVGGElement, SidePortDatum>('.side-port-group');
  sidePorts.classed('input-port-group', false).classed('output-port-group', false);

  if (isConnecting && connectionStart) {
    if (connectionStart.type === 'output') {
      sidePorts.filter((d) => d?.kind === 'input').classed('input-port-group', true);
    } else {
      sidePorts.filter((d) => d?.kind === 'output').classed('output-port-group', true);
    }
  }
}

/**
 * Update ports visual state during connection
 */
export function updatePortsVisualState(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  params: {
    isConnecting: boolean;
    connectionStart: { type: 'input' | 'output' } | null;
    canDropOnPort?: (nodeId: string, portId: string, type: 'input' | 'output') => boolean;
    modeId: DesignerMode;
    getDims: (n: WorkflowNode) => NodeDimensions;
    updatePortHighlighting: (
      key: string,
      canDrop: boolean,
      portGroup: d3.Selection<SVGGElement, unknown, null, undefined>
    ) => void;
  }
) {
  const { isConnecting, connectionStart, canDropOnPort, modeId, getDims, updatePortHighlighting } =
    params;
  const nodeLayer = svg.select('.node-layer');

  // Update input ports visual state
  nodeLayer.selectAll('.input-port-circle').each(function (d: unknown) {
    const portData = d as PortDatum;
    const portElement = d3.select<SVGCircleElement, unknown>(this as SVGCircleElement);
    const parentElement = (this as Element)?.parentNode;
    const portGroup = parentElement ? d3.select(parentElement as SVGGElement) : null;
    const isActive = Boolean(isConnecting && connectionStart && connectionStart.type === 'output');
    const canDrop = isActive ? (canDropOnPort?.(portData.nodeId, portData.id, 'input') ?? false) : false;
    const archNoValidation = modeId === 'architecture';

    if (portGroup) {
      updatePortHighlighting(
        `${portData.nodeId}-${portData.id}`,
        Boolean(isActive && !archNoValidation && canDrop),
        portGroup
      );
    }

    const baseRadius = getDims(portData.nodeData).portRadius || 6;
    const attrs = computePortVisualAttributes(
      isActive,
      archNoValidation,
      Boolean(canDrop),
      baseRadius
    );
    applyPortVisualAttributes(portElement, attrs);
  });

  // Update output ports visual state
  nodeLayer.selectAll('.output-port-circle').each(function (d: unknown) {
    const portData = d as PortDatum;
    const portElement = d3.select<SVGCircleElement, unknown>(this as SVGCircleElement);
    const parentElement = (this as Element)?.parentNode;
    const portGroup = parentElement ? d3.select(parentElement as SVGGElement) : null;
    const isActive = Boolean(isConnecting && connectionStart && connectionStart.type === 'input');
    const canDrop = isActive ? (canDropOnPort?.(portData.nodeId, portData.id, 'output') ?? false) : false;
    const archNoValidation = modeId === 'architecture';

    if (portGroup) {
      portGroup.classed('can-dropped', Boolean(isActive && !archNoValidation && canDrop));
    }

    const baseRadius = getDims(portData.nodeData).portRadius || 6;
    const attrs = computePortVisualAttributes(
      isActive,
      archNoValidation,
      Boolean(canDrop),
      baseRadius
    );
    applyPortVisualAttributes(portElement, attrs);
  });
}
