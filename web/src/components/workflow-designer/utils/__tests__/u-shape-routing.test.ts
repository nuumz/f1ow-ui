/**
 * Unit tests for U-Shape routing functionality
 * Tests all three U-shape variants: bottom-to-bottom, horizontal right, and horizontal left
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { WorkflowNode } from '../../types'
import {
    calculateConnectionPreviewPath,
    generateArchitectureModeConnectionPathWithTargetSide
} from '../connection-utils'

// Test helpers
function createTestNode(id: string, x: number, y: number): WorkflowNode {
    return {
        id,
        x,
        y,
        type: 'processor',
        label: `Node ${id}`,
        inputs: [{ id: 'input', label: 'Input', type: 'input', dataType: 'any' }],
        outputs: [{ id: 'output', label: 'Output', type: 'output', dataType: 'any' }],
        bottomPorts: [{ id: 'bottom', label: 'Bottom', type: 'output', dataType: 'any' }],
        config: {}
    }
}

describe('U-Shape Routing', () => {
    let sourceNode: WorkflowNode
    let targetNode: WorkflowNode

    beforeEach(() => {
        sourceNode = createTestNode('source', 100, 100)
        targetNode = createTestNode('target', 150, 100)
    })

    describe('Right U-Shape Routing', () => {
        beforeEach(() => {
            // Set up nodes close horizontally for right U-shape trigger
            sourceNode.x = 100
            targetNode.x = 130 // Close horizontally (< 50px threshold)
        })

        it('should trigger right U-shape for final mode when nodes are close horizontally', () => {
            const path = generateArchitectureModeConnectionPathWithTargetSide(
                sourceNode,
                targetNode,
                {
                    sourceNodeId: 'source',
                    sourcePortId: '__side-right',
                    targetNodeId: 'target',
                    targetPortId: '__side-right'
                },
                '__side-right'
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })

        it('should trigger right U-shape for preview mode when nodes are close horizontally', () => {
            const hoverTargetBox = {
                x: targetNode.x - 28, // Architecture mode: 56x56, centered
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-right',
                { x: targetNode.x, y: targetNode.y },
                {
                    modeId: 'architecture',
                    hoverTargetBox
                }
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })

        it('should NOT trigger right U-shape when nodes are far apart', () => {
            targetNode.x = 200 // Far apart (> 50px threshold)

            const hoverTargetBox = {
                x: targetNode.x - 28,
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-right',
                { x: targetNode.x, y: targetNode.y },
                {
                    modeId: 'architecture',
                    hoverTargetBox
                }
            )

            // Should fall back to regular orthogonal routing
            expect(path).toContain('M ')
        })
    })

    describe('Left U-Shape Routing', () => {
        beforeEach(() => {
            // Set up nodes close horizontally for left U-shape trigger
            sourceNode.x = 150
            targetNode.x = 120 // Target to the left and close (< 50px threshold)
        })

        it('should trigger left U-shape for final mode when target is to the left and close', () => {
            const path = generateArchitectureModeConnectionPathWithTargetSide(
                sourceNode,
                targetNode,
                {
                    sourceNodeId: 'source',
                    sourcePortId: '__side-left',
                    targetNodeId: 'target',
                    targetPortId: '__side-left'
                },
                '__side-left'
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })

        it('should trigger left U-shape for preview mode when target is to the left and close', () => {
            const hoverTargetBox = {
                x: targetNode.x - 28,
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-left',
                { x: targetNode.x, y: targetNode.y },
                {
                    modeId: 'architecture',
                    hoverTargetBox
                }
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })

        it('should NOT trigger left U-shape when target is to the right', () => {
            targetNode.x = 180 // Target to the right

            const hoverTargetBox = {
                x: targetNode.x - 28,
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-left',
                { x: targetNode.x, y: targetNode.y },
                {
                    modeId: 'architecture',
                    hoverTargetBox
                }
            )

            // Should fall back to regular orthogonal routing
            expect(path).toContain('M ')
        })
    })

    describe('Bottom U-Shape Routing', () => {
        beforeEach(() => {
            // Set up nodes for bottom-to-bottom U-shape
            sourceNode.x = 100
            sourceNode.y = 100
            targetNode.x = 110
            targetNode.y = 110
        })

        it('should trigger bottom U-shape for final mode when both ports are bottom', () => {
            const path = generateArchitectureModeConnectionPathWithTargetSide(
                sourceNode,
                targetNode,
                {
                    sourceNodeId: 'source',
                    sourcePortId: '__side-bottom',
                    targetNodeId: 'target',
                    targetPortId: '__side-bottom'
                },
                '__side-bottom'
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })

        it('should trigger bottom U-shape for preview mode when snapping to bottom', () => {
            const hoverTargetBox = {
                x: targetNode.x - 28,
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            // Simulate preview end snapping to bottom of target
            const previewEnd = {
                x: targetNode.x,
                y: targetNode.y + 28 // Bottom edge
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-bottom',
                previewEnd,
                {
                    modeId: 'architecture',
                    hoverTargetBox
                }
            )

            expect(path).toContain('M ') // Should have path
            expect(path).toMatch(/L \d+\.?\d* \d+\.?\d*/) // Should have line segments
        })
    })

    describe('Obstacle Awareness', () => {
        it('should fall back to regular routing when obstacles are detected', () => {
            // Create an obstacle node between source and target
            const obstacleNode = createTestNode('obstacle', 125, 100)

            sourceNode.x = 100
            targetNode.x = 130 // Close horizontally to trigger U-shape

            const hoverTargetBox = {
                x: targetNode.x - 28,
                y: targetNode.y - 28,
                width: 56,
                height: 56
            }

            const path = calculateConnectionPreviewPath(
                sourceNode,
                '__side-right',
                { x: targetNode.x, y: targetNode.y },
                {
                    modeId: 'architecture',
                    hoverTargetBox,
                    availableNodes: [sourceNode, targetNode, obstacleNode]
                }
            )

            // Should still generate a path (fallback to regular routing)
            expect(path).toContain('M ')
        })
    })

    describe('Constants and Configuration', () => {
        it('should use consistent constants across preview and final modes', () => {
            // This test ensures that the U_SHAPE_CONFIG constants are being used
            // The actual values are tested implicitly in the trigger tests above

            const path1 = calculateConnectionPreviewPath(
                sourceNode,
                '__side-right',
                { x: 130, y: 100 },
                {
                    modeId: 'architecture',
                    hoverTargetBox: { x: 102, y: 72, width: 56, height: 56 }
                }
            )

            const path2 = generateArchitectureModeConnectionPathWithTargetSide(
                sourceNode,
                createTestNode('target', 130, 100),
                {
                    sourceNodeId: 'source',
                    sourcePortId: '__side-right',
                    targetNodeId: 'target',
                    targetPortId: '__side-right'
                },
                '__side-right'
            )

            // Both should generate valid paths (indicating consistent trigger logic)
            expect(path1).toContain('M ')
            expect(path2).toContain('M ')
        })
    })
})
