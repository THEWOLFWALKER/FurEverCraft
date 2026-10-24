import { expect, test, type Page } from '@playwright/test';
import { AttachClient, cleanupAll, expectServerStartupFailure, isProcessAlive, startServer, temporaryStateExists } from './support.js';

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await cleanupAll();
});

const panel = (page: Page, heading: string) =>
  page.locator('section.panel').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });

async function pairBrowser(page: Page, code: string) {
  await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toBeVisible();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toHaveCount(0);
  // The initial 401 must be replaced by a real paired snapshot/read.
  await expect(page.locator('.app-bar')).toContainText('live');
  await expect(page.locator('.hero-meta')).toContainText('profile simulated');
}

async function setGoalFromBrowser(page: Page, goalId: string, text: string) {
  await page.getByRole('button', { name: 'Conversation' }).click();
  await page.getByLabel('Goal id').fill(goalId);
  await page.getByLabel('Goal text').fill(text);
  await page.getByRole('button', { name: 'Set goal' }).click();
  await expect(page.locator('.notice', { hasText: /goal\.set: terminal/ })).toBeVisible();
  const row = panel(page, 'Goals').locator('.row', { hasText: goalId });
  await expect(row).toContainText(text);
  return row;
}

async function browserStatus(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/status');
    return { http: response.status, body: await response.json() as Record<string, unknown> };
  });
}

test('browser pairing, goal, agent execution, effects, cancel, pause/resume and SSE reconnect', async ({ page }) => {
  const server = await startServer();
  const streamRequests: string[] = [];
  page.on('request', request => {
    try { if (new URL(request.url()).pathname === '/api/v1/events/stream') streamRequests.push(request.url()); }
    catch { /* non-URL request */ }
  });
  try {
    await page.goto(server.url);

    // Local pairing is enforced by the serving process, not bypassed by the test.
    await pairBrowser(page, server.pairingCode);
    await expect.poll(() => streamRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

    const goalText = 'Observe and place a block near the starting point';
    const goalRow = await setGoalFromBrowser(page, 'goal-browser', goalText);
    await expect(goalRow).toContainText('revision 1');
    await expect(goalRow.locator('.tag')).toHaveText('active');

    // The agent message really crosses ControlService -> AgentLoop -> ToolRouter -> Executor.
    await page.getByLabel('Message to agent').fill('Execute placement for the current goal');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.notice', { hasText: /message: terminal/ })).toBeVisible();

    await page.getByRole('button', { name: 'Tasks' }).click();
    const placeRow = panel(page, 'Executions').locator('.row', { hasText: 'place_one' }).first();
    await expect(placeRow).toBeVisible();
    // The fixture body applied the placement but returned an ambiguous receipt: the execution
    // must be suspended and its effect ambiguous, never promoted to success.
    await expect(placeRow.locator('.tag')).toHaveText('suspended');
    const placeId = (await placeRow.locator('.row-id').innerText()).trim();
    const placeEffect = panel(page, 'Effects').locator('.row', { hasText: placeId });
    await expect(placeEffect.locator('.tag')).toHaveText('ambiguous');

    // A direct game-chat write produces a second, confirmed execution/effect for comparison.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByLabel('Message to agent').fill('hello from the browser');
    await page.getByRole('button', { name: 'Send game chat' }).click();
    await expect(page.locator('.notice', { hasText: /chat: terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'Tasks' }).click();
    const chatRow = panel(page, 'Executions').locator('.row', { hasText: 'send_chat' }).first();
    await expect(chatRow.locator('.tag')).toHaveText('succeeded');
    const chatId = (await chatRow.locator('.row-id').innerText()).trim();
    await expect(panel(page, 'Effects').locator('.row', { hasText: chatId }).locator('.tag')).toHaveText('confirmed');

    // Cancel a genuinely non-terminal execution and verify the effect is not rewritten.
    await page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Executions' }) }).locator('.row', { hasText: placeId }).click();
    const cancelButton = page.getByRole('button', { name: 'Cancel execution' });
    await expect(cancelButton).toBeEnabled();
    await cancelButton.click();
    await expect(page.locator('.notice', { hasText: /cancel: terminal/ })).toBeVisible();
    await expect(panel(page, 'Executions').locator('.row', { hasText: placeId }).locator('.tag')).toHaveText('canceled');
    await expect(panel(page, 'Effects').locator('.row', { hasText: placeId }).locator('.tag')).toHaveText('ambiguous');

    // Pause stops new work; resume is accepted only from the paused state.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.notice', { hasText: /pause: terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.locator('.hero-status')).toContainText('Paused');
    expect((await browserStatus(page)).body.paused).toBe(true);

    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.notice', { hasText: /resume: terminal/ })).toBeVisible();
    await expect.poll(async () => (await browserStatus(page)).body.paused, { timeout: 10_000 }).toBe(false);

    // Real SSE disconnect/reconnect: the Settings action closes the current EventSource and
    // opens a new one at the retained cursor (observable as a second stream request).
    await page.getByRole('button', { name: 'Settings' }).click();
    const streamsBeforeReconnect = streamRequests.length;
    await page.getByRole('button', { name: 'Reconnect stream' }).click();
    await expect.poll(() => streamRequests.length, { timeout: 15_000 }).toBeGreaterThan(streamsBeforeReconnect);
    await expect(page.locator('.app-bar')).toContainText('live', { timeout: 20_000 });

    // A network outage is a real disconnect: the paired HttpOnly session survives it and the
    // control surface reconnects after the browser comes back online.
    await page.context().setOffline(true);
    await expect(page.reload()).rejects.toThrow();
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toHaveCount(0);
    await expect(page.locator('.app-bar')).toContainText('live');
    await expect(page.locator('.hero-explain')).toContainText(goalText);
    expect((await browserStatus(page)).body.paused).toBe(false);
  } finally {
    await server.stop();
  }
  // Cleanup is asserted, not assumed: no child survives and the isolated state is gone.
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('attach CLI and browser control the same Runtime with one owner', async ({ page }) => {
  const server = await startServer();
  const cli = await AttachClient.start(server.url, server.cliBearer);
  try {
    await page.goto(server.url);
    await pairBrowser(page, server.pairingCode);
    const goalRow = await setGoalFromBrowser(page, 'goal-shared', 'Web sets the first revision');
    await expect(goalRow).toContainText('revision 1');

    await cli.waitSubscription('open');

    // The CLI sees the browser's write through the same ControlService.
    const shown = await cli.command('goal show goal-shared') as Array<{ revision: number }>;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.revision).toBe(1);

    // A CLI write advances the same goal revision; the browser observes it after a real read.
    const revised = await cli.command('goal revise goal-shared 1 Revised by CLI') as { state: string; result?: { revision?: number } };
    expect(revised.state).toBe('terminal');
    expect(revised.result?.revision).toBe(2);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel(page, 'Goals').locator('.row', { hasText: 'goal-shared' })).toContainText('revision 2 · Revised by CLI');

    // Browser-created execution is visible to the CLI, including its confirmed effect.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByLabel('Message to agent').fill('chat from the browser');
    await page.getByRole('button', { name: 'Send game chat' }).click();
    await expect(page.locator('.notice', { hasText: /chat: terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'Tasks' }).click();
    const webChatRow = panel(page, 'Executions').locator('.row', { hasText: 'send_chat' }).first();
    await expect(webChatRow.locator('.tag')).toHaveText('succeeded');
    const webChatId = (await webChatRow.locator('.row-id').innerText()).trim();

    const cliExecutions = await cli.command('executions') as Array<{ execution_id: string; skill_id: string }>;
    expect(cliExecutions.some(execution => execution.execution_id === webChatId && execution.skill_id === 'send_chat')).toBe(true);
    const cliEffects = await cli.command(`effects ${webChatId}`) as Array<{ execution_id: string; status: string }>;
    expect(cliEffects).toEqual([expect.objectContaining({ execution_id: webChatId, status: 'confirmed' })]);

    // CLI-created execution is visible to the browser.
    const knownExecutionIds = new Set(cliExecutions.map(execution => execution.execution_id));
    const cliChat = await cli.command('chat chat from the CLI') as { state: string };
    expect(cliChat.state).toBe('terminal');
    const afterCliChat = await cli.command('executions') as Array<{ execution_id: string; skill_id: string }>;
    const cliCreated = afterCliChat.filter(execution => execution.skill_id === 'send_chat' && !knownExecutionIds.has(execution.execution_id));
    expect(cliCreated).toHaveLength(1);
    const cliExecutionId = cliCreated[0]!.execution_id;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel(page, 'Executions').locator('.row', { hasText: cliExecutionId })).toContainText('send_chat');
    await expect(panel(page, 'Executions').locator('.row', { hasText: cliExecutionId }).locator('.tag')).toHaveText('succeeded');

    // Browser pause is observed by the CLI; CLI resume is observed by the browser.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.notice', { hasText: /pause: terminal/ })).toBeVisible();
    expect(await cli.command('status')).toMatchObject({ paused: true });
    expect((await cli.command('resume') as { state: string }).state).toBe('terminal');
    await expect.poll(async () => (await browserStatus(page)).body.paused).toBe(false);

    // CLI subscription disconnect does not create a second Runtime; reconnect resumes the same state.
    cli.send('disconnect');
    await cli.waitSubscription('disconnected');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.notice', { hasText: /pause: terminal/ })).toBeVisible();
    expect(await cli.command('status')).toMatchObject({ paused: true });
    cli.send('reconnect');
    await cli.waitSubscription('open');
    expect(await cli.command('status')).toMatchObject({ paused: true });
    await cli.command('resume');

    // A second server on the same storage path is refused: one Runtime owner, not two.
    const failure = await expectServerStartupFailure(server.db);
    expect(failure.timedOut).toBe(false);
    expect(failure.code).not.toBe(0);
    expect(`${failure.stdout}\n${failure.stderr}`).toContain('runtime-control-owned');
    // The first Runtime is unaffected by the refused second owner.
    expect((await browserStatus(page)).http).toBe(200);

    // Neither credential ever appears in the attach transcript.
    expect(cli.transcript).not.toContain(server.cliBearer);
    expect(cli.transcript).not.toContain('furevercraft_session');
  } finally {
    await cli.close();
    await server.stop();
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});
