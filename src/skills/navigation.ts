import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { nextId } from '../contracts/index.js';
export type NavigationResult = { executionId: string; status: 'succeeded' | 'failed'; path: string[]; reason?: string };

export function navigate(bridge: ClientBridgeCapabilities, target: { x: number; y: number }, budget = 3): NavigationResult {
  const executionId = nextId('exec');
  const path: string[] = [];
  for (let attempt = 0; attempt <= budget; attempt++) {
    const q = [{ x: bridge.position.x, y: bridge.position.y, path: [] as string[] }];
    const seen = new Set([`${bridge.position.x},${bridge.position.y}`]);
    let found: string[] | undefined;
    while (q.length) {
      const n = q.shift()!;
      if (n.x === target.x && n.y === target.y) { found = n.path; break; }
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const x = n.x + dx, y = n.y + dy, k = `${x},${y}`;
        if (x >= 0 && y >= 0 && x < bridge.size && y < bridge.size && !seen.has(k) && bridge.cell(x, y) === 'free') { seen.add(k); q.push({ x, y, path: [...n.path, k] }); }
      }
    }
    if (!found) return { executionId, status: 'failed', path, reason: 'no-known-path' };
    try {
      for (const k of found) {
        const [x, y] = k.split(',').map(Number) as [number, number];
        const before = `${bridge.position.x},${bridge.position.y}`;
        bridge.walk(x, y);
        // A silent drop leaves the body in place; the step did not happen, so the route is void.
        if (`${bridge.position.x},${bridge.position.y}` === before) return { executionId, status: 'failed', path, reason: 'walk-dropped' };
        path.push(k);
      }
      // Success means the body actually reached the target, not that the planned steps ran.
      if (bridge.position.x !== target.x || bridge.position.y !== target.y) return { executionId, status: 'failed', path, reason: 'target-not-reached' };
      return { executionId, status: 'succeeded', path };
    } catch {
      if (attempt === budget) return { executionId, status: 'failed', path, reason: 'replan-budget-exhausted' };
    }
  }
  return { executionId, status: 'failed', path, reason: 'unreachable' };
}
