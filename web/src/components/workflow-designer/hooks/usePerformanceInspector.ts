/**
 * Advanced performance monitoring hook for workflow designer
 * Tracks render performance, memory usage, and identifies bottlenecks
 */

import { useEffect, useRef, useCallback, useMemo } from 'react';

interface PerformanceMetrics {
  renderCount: number;
  lastRenderTime: number;
  avgRenderTime: number;
  memoryUsage?: number;
  componentName: string;
  renderHistory: number[];
}

interface PerformanceThresholds {
  maxRenderTime: number;
  maxRenderCount: number;
  memoryWarningThreshold: number;
}

const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  maxRenderTime: 16, // 60 FPS target
  maxRenderCount: 10, // Max renders per second
  memoryWarningThreshold: 50 * 1024 * 1024, // 50MB
};

// Global performance registry
const performanceRegistry = new Map<string, PerformanceMetrics>();

export function usePerformanceInspector(
  componentName: string,
  thresholds: Partial<PerformanceThresholds> = {},
  enabled = process.env.NODE_ENV === 'development'
) {
  const renderCountRef = useRef(0);
  const renderTimesRef = useRef<number[]>([]);
  const lastRenderStartRef = useRef<number>(0);
  // Throttle noisy logs so they don't themselves cause slowdowns
  const lastWarnTimeRef = useRef<number>(0);
  const suppressedWarnsRef = useRef<number>(0);
  // Sample memory less frequently to avoid overhead on every render
  const lastMemorySampleTimeRef = useRef<number>(0);
  const lastSampledMemoryRef = useRef<number | undefined>(undefined);
  const finalThresholds = useMemo(() => ({ ...DEFAULT_THRESHOLDS, ...thresholds }), [thresholds]);

  // Start render timing
  // Get memory usage if available
  const getMemoryUsage = useCallback((): number | undefined => {
    const now = performance.now();
    // Only sample at most once every 250ms to reduce overhead
    if (now - lastMemorySampleTimeRef.current < 250) {
      return lastSampledMemoryRef.current;
    }
    lastMemorySampleTimeRef.current = now;
    const perf = performance as unknown as Record<string, unknown>;
    if ('memory' in perf && typeof perf.memory === 'object' && perf.memory && 'usedJSHeapSize' in perf.memory) {
      const value = (perf.memory as Record<string, number>).usedJSHeapSize;
      lastSampledMemoryRef.current = value;
      return value;
    }
    lastSampledMemoryRef.current = undefined;
    return lastSampledMemoryRef.current;
  }, []);

  const startRender = useCallback(() => {
    if (!enabled) {
      return;
    }
    lastRenderStartRef.current = performance.now();
  }, [enabled]);

  // End render timing and record metrics
  const endRender = useCallback(() => {
    if (!enabled) {
      return;
    }

    const renderTime = performance.now() - lastRenderStartRef.current;
    renderCountRef.current += 1;
    renderTimesRef.current.push(renderTime);

    // Keep only last 100 render times for memory efficiency
    if (renderTimesRef.current.length > 100) {
      renderTimesRef.current = renderTimesRef.current.slice(-100);
    }

    // Update global registry
    const avgRenderTime = renderTimesRef.current.reduce((sum, time) => sum + time, 0) / renderTimesRef.current.length;

    performanceRegistry.set(componentName, {
      renderCount: renderCountRef.current,
      lastRenderTime: renderTime,
      avgRenderTime,
      componentName,
      renderHistory: [...renderTimesRef.current],
      memoryUsage: getMemoryUsage(),
    });

    // Performance warnings
    if (renderTime > finalThresholds.maxRenderTime) {
      const now = performance.now();
      // Warn at most once every 500ms per component to avoid console overhead
      if (now - lastWarnTimeRef.current > 500) {
        if (suppressedWarnsRef.current > 0) {
          // Surface how many were suppressed to keep signal without noise
          console.warn(
            `🐌 Slow render detected in ${componentName}: ${renderTime.toFixed(2)}ms (threshold: ${finalThresholds.maxRenderTime}ms) – suppressed ${suppressedWarnsRef.current} similar warnings`
          );
          suppressedWarnsRef.current = 0;
        } else {
          console.warn(
            `🐌 Slow render detected in ${componentName}: ${renderTime.toFixed(2)}ms (threshold: ${finalThresholds.maxRenderTime}ms)`
          );
        }
        lastWarnTimeRef.current = now;
      } else {
        suppressedWarnsRef.current += 1;
      }
    }

    if (renderCountRef.current % 60 === 0) { // Check every 60 renders
      const recentRenders = renderTimesRef.current.slice(-60);
      const avgRecent = recentRenders.reduce((sum, time) => sum + time, 0) / recentRenders.length;

      if (avgRecent > finalThresholds.maxRenderTime * 0.8) {
        console.warn(`⚠️ Performance degradation in ${componentName}: avg ${avgRecent.toFixed(2)}ms over last 60 renders`);
      }
    }
  }, [enabled, componentName, finalThresholds, getMemoryUsage]);

  // Track component mount/unmount
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const mountTime = performance.now();
    // Use warn channel to comply with linting rules
    console.warn(`🏗️ ${componentName} mounted at ${mountTime.toFixed(2)}ms`);

    return () => {
      const unmountTime = performance.now();
      console.warn(`🗑️ ${componentName} unmounted at ${unmountTime.toFixed(2)}ms`);

      // Clean up from registry
      performanceRegistry.delete(componentName);
    };
  }, [enabled, componentName]);

  // Auto-start render timing on each render
  useEffect(() => {
    // Mark the start during render; writing to ref is safe in render phase
    if (enabled) {
      lastRenderStartRef.current = performance.now();
    }
    // Use rAF instead of setTimeout to avoid timer contention and to measure after paint
    const rafId = requestAnimationFrame(() => {
      endRender();
    });
    return () => cancelAnimationFrame(rafId);
  });

  // Memoized performance summary
  const performanceSummary = useMemo(() => {
    if (!enabled) { return null; }

    const metrics = performanceRegistry.get(componentName);
    if (!metrics) { return null; }

    return {
      renderCount: metrics.renderCount,
      avgRenderTime: metrics.avgRenderTime,
      lastRenderTime: metrics.lastRenderTime,
      memoryUsage: metrics.memoryUsage,
      isPerformant: metrics.avgRenderTime < finalThresholds.maxRenderTime,
      memoryWarning: metrics.memoryUsage ? metrics.memoryUsage > finalThresholds.memoryWarningThreshold : false,
    };
  }, [enabled, componentName, finalThresholds]);

  return {
    performanceSummary,
    startRender,
    endRender,
    getMetrics: () => performanceRegistry.get(componentName),
    getAllMetrics: () => Array.from(performanceRegistry.values()),
  };
}

// Hook for monitoring context re-renders
export function useContextPerformanceMonitor(contextName: string) {
  const contextUpdatesRef = useRef(0);
  const lastUpdateTimeRef = useRef(performance.now());

  const trackUpdate = useCallback(() => {
    const now = performance.now();
    const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
    contextUpdatesRef.current += 1;
    lastUpdateTimeRef.current = now;

    if (timeSinceLastUpdate < 16) { // Less than one frame
      console.warn(`🔄 Rapid context updates in ${contextName}: ${timeSinceLastUpdate.toFixed(2)}ms since last update`);
    }

    if (contextUpdatesRef.current % 50 === 0) {
      console.warn(`📊 ${contextName} context has updated ${contextUpdatesRef.current} times`);
    }
  }, [contextName]);

  useEffect(trackUpdate);

  return {
    updateCount: contextUpdatesRef.current,
    trackUpdate,
  };
}

// Global performance analysis utilities
export const PerformanceAnalyzer = {
  getTopSlowComponents: (limit = 5) => {
    return Array.from(performanceRegistry.values())
      .sort((a, b) => b.avgRenderTime - a.avgRenderTime)
      .slice(0, limit);
  },

  getTotalRenderCount: () => {
    return Array.from(performanceRegistry.values())
      .reduce((total, metrics) => total + metrics.renderCount, 0);
  },

  getMemorySnapshot: () => {
    const components = Array.from(performanceRegistry.values());
    const totalMemory = components.reduce((total, metrics) =>
      total + (metrics.memoryUsage || 0), 0);

    return {
      componentCount: components.length,
      totalMemoryUsage: totalMemory,
      averageMemoryPerComponent: totalMemory / components.length,
      memoryHeavyComponents: components.filter(m =>
        m.memoryUsage && m.memoryUsage > DEFAULT_THRESHOLDS.memoryWarningThreshold
      ),
    };
  },

  generateReport: () => {
    const slowComponents = PerformanceAnalyzer.getTopSlowComponents();
    const memorySnapshot = PerformanceAnalyzer.getMemorySnapshot();
    // Summarize with warn to comply with lint policy
    console.warn('🔍 Workflow Designer Performance Report');
    console.warn('📈 Render Performance:', slowComponents.map(m => ({
      component: m.componentName,
      avgMs: Number(m.avgRenderTime.toFixed(2)),
      lastMs: Number(m.lastRenderTime.toFixed(2)),
      count: m.renderCount,
    })));
    console.warn(
      '💾 Memory Usage:',
      {
        components: memorySnapshot.componentCount,
        totalMB: Number((memorySnapshot.totalMemoryUsage / 1024 / 1024).toFixed(2)),
        avgMB: Number((memorySnapshot.averageMemoryPerComponent / 1024 / 1024).toFixed(2)),
      }
    );
    if (memorySnapshot.memoryHeavyComponents.length > 0) {
      console.warn('⚠️ Memory Heavy Components:', memorySnapshot.memoryHeavyComponents.map(m => ({
        component: m.componentName,
        mb: Number(((m.memoryUsage || 0) / 1024 / 1024).toFixed(2)),
      })));
    }
  },
};

// Development-only global performance commands
if (process.env.NODE_ENV === 'development') {
  // Extend window typing via declaration merge
  (window as unknown as { WorkflowPerformance?: typeof PerformanceAnalyzer }).WorkflowPerformance = PerformanceAnalyzer;
}