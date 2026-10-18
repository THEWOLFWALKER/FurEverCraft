import { it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
it('probe quit', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'q-')), 'r.sqlite');
  const runtime = createRuntime({ db });
  const control: any = runtime.control;
  console.log('close code', (runtime.close as any).toString());
  console.log('store close code', (runtime.store.close as any).toString());
  runtime.close();
});
