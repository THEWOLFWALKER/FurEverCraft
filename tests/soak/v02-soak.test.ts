import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { ManualClock } from '../../src/contracts/index.js';

describe('V02 virtual-time soak', () => {
  it('runs 60 virtual minutes through repeated control and observation cycles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-soak-'));
    const clock = new ManualClock();
    const runtime = createRuntime({ db: join(dir, 'soak.sqlite'), clock });
    try {
      for (let minute = 0; minute < 60; minute += 1) {
        clock.advance(60_000);
        const result = await runtime.control.command({ requestId: `state-${minute}`, command: 'message', payload: { text: `observe cycle ${minute}` } });
        expect(['terminal', 'rejected']).toContain(result.state);
        expect(runtime.control.status().context.serverProfileId).toBe('simulated');
      }
      expect(runtime.control.events('0', 500).events.length).toBeGreaterThan(0);
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
