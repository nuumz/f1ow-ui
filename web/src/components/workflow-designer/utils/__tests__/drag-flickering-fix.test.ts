/// <reference types="vitest" />
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { updateDraggedNodePosition, clearAllDragTracking } from '../visual-state-manager'
import type { DragPositionConfig } from '../visual-state-manager'

describe('Drag Flickering Fix - Visual State Manager', () => {
    let mockDragConfig: DragPositionConfig
    let mockCurrentDragPositions: Map<string, { x: number; y: number }>
    let mockUpdateConnDragPos: (nodeId: string, pos: { x: number; y: number }) => void
    let mockNodeConnectionsMap: Map<string, any[]>
    let mockConnectionUpdateQueue: Set<string>
    let lastDragUpdateRef: { current: number }

    beforeEach(() => {
        mockCurrentDragPositions = new Map()
        mockUpdateConnDragPos = vi.fn()
        mockNodeConnectionsMap = new Map([
            ['nodeA', [{ id: 'conn1', sourceNodeId: 'nodeA', targetNodeId: 'nodeB' }]],
            ['nodeB', [{ id: 'conn1', sourceNodeId: 'nodeA', targetNodeId: 'nodeB' }]],
            ['nodeC', [{ id: 'conn2', sourceNodeId: 'nodeC', targetNodeId: 'nodeA' }]]
        ])
        mockConnectionUpdateQueue = new Set()
        lastDragUpdateRef = { current: 0 }

        mockDragConfig = {
            draggedElement: null,
            currentDragPositions: mockCurrentDragPositions,
            updateConnDragPos: mockUpdateConnDragPos,
            nodeConnectionsMap: mockNodeConnectionsMap,
            connectionUpdateQueue: mockConnectionUpdateQueue,
            lastDragUpdate: lastDragUpdateRef,
            dragUpdateThrottle: 0, // No throttling for tests
            startBatchedConnectionUpdates: vi.fn()
        }
    })

    it('should reset stale smoothed positions when drag position is too far from new position', () => {
        // Set an existing drag position that's far from new position (stale)
        mockCurrentDragPositions.set('nodeA', { x: 1000, y: 1000 })

        // Update with a new position that's very far away (> 100px = stale threshold)
        updateDraggedNodePosition('nodeA', 0, 0, mockDragConfig)

        // The smoothed position should start fresh from the new position, not use the stale one
        const updatedPosition = mockCurrentDragPositions.get('nodeA')!

        // With smoothing alpha of 0.5, if it used stale position (1000, 1000):
        // smoothedX = 1000 + (0 - 1000) * 0.5 = 500
        // But if it detected stale and reset:
        // smoothedX = 0 + (0 - 0) * 0.5 = 0
        expect(updatedPosition.x).toBe(0)
        expect(updatedPosition.y).toBe(0)
    })

    it('should use previous position for smoothing when position is close (not stale)', () => {
        // Set an existing drag position that's close to new position (not stale)
        mockCurrentDragPositions.set('nodeA', { x: 10, y: 10 })

        // Update with a new position that's close (< 100px away)
        updateDraggedNodePosition('nodeA', 20, 20, mockDragConfig)

        // The smoothed position should use smoothing with previous position
        const updatedPosition = mockCurrentDragPositions.get('nodeA')!

        // With smoothing alpha of 0.5:
        // smoothedX = 10 + (20 - 10) * 0.5 = 15
        // smoothedY = 10 + (20 - 10) * 0.5 = 15
        expect(updatedPosition.x).toBe(15)
        expect(updatedPosition.y).toBe(15)
    })

    it('should start fresh when no previous position exists', () => {
        // No existing position for nodeA
        expect(mockCurrentDragPositions.has('nodeA')).toBe(false)

        // Update with new position
        updateDraggedNodePosition('nodeA', 100, 200, mockDragConfig)

        // Should start fresh (no smoothing on first update)
        const updatedPosition = mockCurrentDragPositions.get('nodeA')!
        expect(updatedPosition.x).toBe(100)
        expect(updatedPosition.y).toBe(200)
    })

    it('should clear all tracking state properly', () => {
        // Set up some state to clear
        mockCurrentDragPositions.set('nodeA', { x: 50, y: 50 })
        mockCurrentDragPositions.set('nodeB', { x: 100, y: 100 })

        // Mock window globals for adaptive performance
        global.window = {
            __wfAdaptive: { vBudget: 6, lastDuration: 10 },
            __wfConnAdaptive: { cBudget: 10, lastDuration: 15 }
        } as any

        // Clear all tracking
        clearAllDragTracking()

        // Check that adaptive configs were reset
        expect(window.__wfAdaptive?.lastDuration).toBe(0)
        expect(window.__wfAdaptive?.vBudget).toBe(4) // Reset to default
        expect(window.__wfConnAdaptive?.lastDuration).toBe(0)
        expect(window.__wfConnAdaptive?.cBudget).toBe(8) // Reset to default
    })

    it('should call updateConnDragPos with smoothed coordinates', () => {
        // Clear the mock to track calls
        mockUpdateConnDragPos = vi.fn()
        mockDragConfig.updateConnDragPos = mockUpdateConnDragPos

        // Update position
        updateDraggedNodePosition('nodeA', 100, 200, mockDragConfig)

        // Should have called updateConnDragPos with the smoothed position
        expect(mockUpdateConnDragPos).toHaveBeenCalledWith('nodeA', { x: 100, y: 200 })
    })

    it('should handle rapid position updates without accumulating stale state', () => {
        // Simulate rapid updates like would happen during drag
        updateDraggedNodePosition('nodeA', 0, 0, mockDragConfig)
        updateDraggedNodePosition('nodeA', 10, 10, mockDragConfig)
        updateDraggedNodePosition('nodeA', 20, 20, mockDragConfig)

        const finalPosition = mockCurrentDragPositions.get('nodeA')!

        // Position should be smoothed towards the target (with alpha=0.5, it approaches but doesn't reach immediately)
        // After 3 updates: 0 -> 0 -> 5 -> 12.5
        expect(finalPosition.x).toBeCloseTo(12.5, 0.1) // Should be smoothed position
        expect(finalPosition.y).toBeCloseTo(12.5, 0.1)
        expect(finalPosition.x).toBeGreaterThan(10) // Should be progressing towards target
        expect(finalPosition.y).toBeGreaterThan(10)
    })
})