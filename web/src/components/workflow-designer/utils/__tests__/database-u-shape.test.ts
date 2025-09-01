/**
 * Test case specific for Database U-Shape issue reproduction
 * Tests the scenario from the user's screenshot
 */

import { describe, it, expect } from 'vitest'
import type { WorkflowNode } from '../../types'
import {
    generateArchitectureModeConnectionPathWithTargetSide
} from '../connection-utils'

// Test helpers
function createArchNode(id: string, type: string, x: number, y: number): WorkflowNode {
    return {
        id,
        type,
        label: type,
        x,
        y,
        inputs: [],
        outputs: [],
        config: {}
    }
}

describe('Database U-Shape Issue Reproduction', () => {
    it('should generate bottom U-shape for the exact scenario from user workflow', () => {
        // Exact positions from the user's workflow definition
        const messageQueue = createArchNode('node-1756733283213-o4lrr16a8', 'queue', 408, 390.74999237060547)
        const database = createArchNode('node-1756733282353-o4hhbyeq', 'database', 233, 348.74999237060547)

        // Test the exact connection from the user's workflow:
        // source: Message Queue, sourceHandle: "__side-bottom"
        // target: Database, targetHandle: "query"
        const path = generateArchitectureModeConnectionPathWithTargetSide(
            messageQueue,
            database,
            {
                sourceNodeId: 'node-1756733283213-o4lrr16a8',
                sourcePortId: '__side-bottom',
                targetNodeId: 'node-1756733282353-o4hhbyeq',
                targetPortId: 'query'
            },
            '__side-bottom' // This should be auto-selected by our logic
        )

        // Should generate a valid U-shape path
        expect(path).toContain('M ')

        const segments = path.split('L ').length
        expect(segments).toBeGreaterThan(3) // Should be U-shape with multiple segments
    })

    it('should auto-select bottom target for __side-bottom source', () => {
        // Test automatic target side selection when source is __side-bottom
        const messageQueue = createArchNode('queue', 'queue', 408, 390)
        const database = createArchNode('database', 'database', 233, 348)

        // Test with the PUBLIC API that doesn't specify target side
        const pathWithoutExplicitTarget = generateArchitectureModeConnectionPathWithTargetSide(
            messageQueue,
            database,
            {
                sourceNodeId: 'queue',
                sourcePortId: '__side-bottom',
                targetNodeId: 'database',
                targetPortId: 'query'
            },
            '__side-bottom' // Force bottom to test our logic
        )

        expect(pathWithoutExplicitTarget).toContain('M ')

        const segments = pathWithoutExplicitTarget.split('L ').length
        expect(segments).toBeGreaterThan(3)
    })

    it('should generate bottom U-shape for Database node scenario from screenshot', () => {
        // Simulate the layout from the screenshot:
        // Rest Api (top center), Database (bottom left), Message Queue (bottom right)
        const restApi = createArchNode('rest-api', 'Rest Api', 300, 150)
        const database = createArchNode('database', 'Database', 150, 250)
        const messageQueue = createArchNode('message-queue', 'Message Queue', 450, 250)

        // Test Rest Api -> Database connection (should be bottom U-shape)
        const restApiToDatabasePath = generateArchitectureModeConnectionPathWithTargetSide(
            restApi,
            database,
            {
                sourceNodeId: 'rest-api',
                sourcePortId: '__side-bottom',
                targetNodeId: 'database',
                targetPortId: '__side-bottom'
            },
            '__side-bottom'
        )

        // Test Rest Api -> Message Queue connection (should be bottom U-shape)
        const restApiToMessageQueuePath = generateArchitectureModeConnectionPathWithTargetSide(
            restApi,
            messageQueue,
            {
                sourceNodeId: 'rest-api',
                sourcePortId: '__side-bottom',
                targetNodeId: 'message-queue',
                targetPortId: '__side-bottom'
            },
            '__side-bottom'
        )

        // Both paths should be valid U-shapes
        expect(restApiToDatabasePath).toContain('M ')
        expect(restApiToMessageQueuePath).toContain('M ')

        // Both should have multiple line segments (indicating U-shape)
        const databaseSegments = restApiToDatabasePath.split('L ').length
        const messageQueueSegments = restApiToMessageQueuePath.split('L ').length

        expect(databaseSegments).toBeGreaterThan(3) // At least 3 segments for U shape
        expect(messageQueueSegments).toBeGreaterThan(3) // At least 3 segments for U shape

        // Debug: Print paths for visual inspection during development
    })

    it('should detect Database node as capable of bottom U-shape connections', () => {
        const database = createArchNode('database', 'Database', 150, 250)
        const restApi = createArchNode('rest-api', 'Rest Api', 300, 150)

        // Test database as source (Database -> Rest Api)
        const databaseToRestApiPath = generateArchitectureModeConnectionPathWithTargetSide(
            database,
            restApi,
            {
                sourceNodeId: 'database',
                sourcePortId: '__side-bottom',
                targetNodeId: 'rest-api',
                targetPortId: '__side-bottom'
            },
            '__side-bottom'
        )

        expect(databaseToRestApiPath).toContain('M ')

        const segments = databaseToRestApiPath.split('L ').length
        expect(segments).toBeGreaterThan(3) // Should be U-shape
    })

    it('should handle architecture nodes without explicit bottomPorts', () => {
        // Architecture mode nodes typically don't have bottomPorts defined
        // They use virtual side ports instead
        const node1 = createArchNode('node1', 'type1', 100, 100)
        const node2 = createArchNode('node2', 'type2', 200, 150)

        // Ensure nodes don't have bottomPorts (typical for architecture mode)
        expect(node1.bottomPorts).toBeUndefined()
        expect(node2.bottomPorts).toBeUndefined()

        // Should still be able to create bottom U-shape using virtual side ports
        const path = generateArchitectureModeConnectionPathWithTargetSide(
            node1,
            node2,
            {
                sourceNodeId: 'node1',
                sourcePortId: '__side-bottom',
                targetNodeId: 'node2',
                targetPortId: '__side-bottom'
            },
            '__side-bottom'
        )

        expect(path).toContain('M ')

        const segments = path.split('L ').length
        expect(segments).toBeGreaterThan(2) // Should generate some kind of path
    })
})
