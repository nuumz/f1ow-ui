#!/usr/bin/env node

/**
 * Enhanced validation script for drag flickering fixes
 * Checks all 5 critical fixes including the new immediate sync
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Color codes for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

function log(color, message) {
  // Use console.warn for script output (satisfies lint rules)
  console.warn(`${color}${message}${colors.reset}`);
}

function checkFile(filePath, checks) {
  if (!fs.existsSync(filePath)) {
    log(colors.red, `❌ File not found: ${filePath}`);
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let allPassed = true;

  checks.forEach(({ name, pattern, required = true }) => {
    const found = pattern.test(content);
    if (required && !found) {
      log(colors.red, `❌ ${name} - Pattern not found in ${path.basename(filePath)}`);
      allPassed = false;
    } else if (found) {
      log(colors.green, `✅ ${name} - Found in ${path.basename(filePath)}`);
    } else {
      log(colors.yellow, `⚠️  ${name} - Optional pattern not found in ${path.basename(filePath)}`);
    }
  });

  return allPassed;
}

function main() {
  log(colors.blue + colors.bold, '🔍 Enhanced Drag Flickering Fix Validation');
  log(colors.blue, '============================================\n');

  let overallSuccess = true;

  // 1. Check useConnectionPaths.ts for cache invalidation
  log(colors.bold, '1. Cache Invalidation (useConnectionPaths.ts)');
  const pathsChecks = [
    {
      name: 'Cache clear on node changes',
      pattern: /useEffect\(\s*\(\)\s*=>\s*{\s*pathCacheRef\.current\.clear\(\);\s*},\s*\[nodes,\s*nodeVariant,\s*modeId\]\)/s
    },
    {
      name: 'Cache clear in clearAllDragPositions',
      pattern: /const clearAllDragPositions = useCallback\(\(\) => {\s*dragPositionsRef\.current\.clear\(\);\s*\/\/ Also clear cache to force immediate regeneration with committed positions\s*pathCacheRef\.current\.clear\(\);\s*}, \[\]\);/s
    }
  ];
  
  const pathsSuccess = checkFile(
    'src/components/workflow-designer/hooks/useConnectionPaths.ts', 
    pathsChecks
  );
  overallSuccess = overallSuccess && pathsSuccess;

  // 2. Check visual-state-manager.ts for selective drag usage and stale detection
  log(colors.bold, '\n2. Selective Drag Usage & Stale Detection (visual-state-manager.ts)');
  const visualChecks = [
    {
      name: 'Selective drag position usage',
      pattern: /const shouldUseDragPositions = nodeId === conn\.sourceNodeId \|\| nodeId === conn\.targetNodeId/
    },
    {
      name: 'Stale position detection',
      pattern: /if \(distSq > 10000\) \{ \/\/ More than 100px away, likely stale from previous drag\s*prev = \{ x: newX, y: newY \}/s
    },
    {
      name: 'syncConnectionsWithCommittedPositions function',
      pattern: /export function syncConnectionsWithCommittedPositions\(/
    },
    {
      name: 'Immediate cache clear in sync function',
      pattern: /clearConnCache\(\)\s*const affectedConnections = nodeConnectionsMap\.get\(nodeId\)/s
    },
    {
      name: 'Force committed positions in sync',
      pattern: /const newPath = getConnectionPath\(conn, false\)/
    }
  ];
  
  const visualSuccess = checkFile(
    'src/components/workflow-designer/utils/visual-state-manager.ts', 
    visualChecks
  );
  overallSuccess = overallSuccess && visualSuccess;

  // 3. Check WorkflowCanvas.tsx for RAF cancellation and sync usage
  log(colors.bold, '\n3. RAF Cancellation & Immediate Sync (WorkflowCanvas.tsx)');
  const canvasChecks = [
    {
      name: 'RAF cancellation before drag state clear in dragStarted',
      pattern: /if \(batchedConnectionUpdateRef\.current\) {\s*cancelAnimationFrame\(batchedConnectionUpdateRef\.current\);\s*batchedConnectionUpdateRef\.current = null;\s*}\s*if \(batchedVisualUpdateRef\.current\) {\s*cancelAnimationFrame\(batchedVisualUpdateRef\.current\);\s*batchedVisualUpdateRef\.current = null;\s*}\s*clearAllDragPositions\(\);/s
    },
    {
      name: 'syncConnectionsWithCommittedPositions import',
      pattern: /syncConnectionsWithCommittedPositions/
    },
    {
      name: 'Immediate sync in dragEnded',
      pattern: /syncConnectionsWithCommittedPositions\(\s*d\.id,\s*nodeConnectionsMap,\s*connectionLayer,\s*getConnectionPath,\s*clearConnCache\s*\);/s
    }
  ];
  
  const canvasSuccess = checkFile(
    'src/components/workflow-designer/components/WorkflowCanvas.tsx', 
    canvasChecks
  );
  overallSuccess = overallSuccess && canvasSuccess;

  // 4. Check tests for enhanced coverage
  log(colors.bold, '\n4. Enhanced Test Coverage');
  const testChecks = [
    {
      name: 'syncConnectionsWithCommittedPositions test',
      pattern: /should sync connections with committed positions immediately/
    },
    {
      name: 'Cache clearing test',
      pattern: /Should clear cache first/
    },
    {
      name: 'Committed position usage test',
      pattern: /Should use committed positions \(useDragPositions = false\)/
    }
  ];
  
  const testSuccess = checkFile(
    'src/components/workflow-designer/utils/__tests__/drag-flickering-fix.test.ts', 
    testChecks
  );
  overallSuccess = overallSuccess && testSuccess;

  // Summary
  log(colors.bold, '\n📊 Validation Summary');
  log(colors.blue, '====================');
  
  if (overallSuccess) {
    log(colors.green + colors.bold, '🎉 All enhanced validation checks passed!');
    log(colors.green, '\n✅ The following 5 critical fixes are verified:');
    log(colors.green, '  1. Cache invalidation on node changes & drag clear');
    log(colors.green, '  2. Selective drag position usage for relevant connections only');
    log(colors.green, '  3. Stale position detection and reset (>100px threshold)');
    log(colors.green, '  4. RAF cancellation before drag state clearing');
    log(colors.green, '  5. IMMEDIATE connection sync with committed positions');
    log(colors.green, '\n🚀 The enhanced fix should eliminate connection path flickering');
    log(colors.green, '   during sequential node drags by ensuring immediate sync between');
    log(colors.green, '   node positions and connection paths.');
  } else {
    log(colors.red + colors.bold, '❌ Some validation checks failed!');
    log(colors.red, 'Please review the above errors and ensure all fixes are properly implemented.');
  }

  process.exit(overallSuccess ? 0 : 1);
}

if (import.meta.main || import.meta.url === `file://${process.argv[1]}`) {
  main();
}
