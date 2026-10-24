import { expect, test, type Page } from '@playwright/test';
import { AttachClient, cleanupAll, expectServerStartupFailure, isProcessAlive, sendControlCommand, startServer, startServe, temporaryStateExists } from './support.js';

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

    // Real SSE cursor resync: read the cursor the UI actually exposes, force the next stream
    // connection to fail, publish an event through the local command API while the browser is
    // disconnected, then let the client retry at its retained cursor and prove the missed event
    // is replayed rather than silently lost.
    await page.getByRole('button', { name: 'Settings' }).click();
    const snapshotCursor = page.getByTestId('snapshot-cursor');
    await expect(snapshotCursor).toHaveText(/^\d+$/);
    const cursorBeforeDisconnect = (await snapshotCursor.innerText()).trim();
    const cursorValue = Number(cursorBeforeDisconnect);
    expect(cursorValue).toBeGreaterThan(0);
    const eventPanel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: /Event stream/ }) });

    let abortedStreamRequests = 0;
    await page.route('**/api/v1/events/stream*', async route => {
      abortedStreamRequests += 1;
      await route.abort('failed');
    });
    const streamsBeforeReconnect = streamRequests.length;
    await page.getByRole('button', { name: 'Reconnect stream' }).click();
    await expect.poll(() => abortedStreamRequests, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.locator('.app-bar')).toContainText('stream unavailable', { timeout: 20_000 });
    // The reconnect was attempted at exactly the cursor the UI displayed, not at zero.
    const reconnectUrls = () => streamRequests.slice(streamsBeforeReconnect);
    await expect.poll(
      () => reconnectUrls().some(url => new URL(url).searchParams.get('cursor') === cursorBeforeDisconnect),
      { timeout: 15_000 },
    ).toBe(true);
    const reconnectUrl = reconnectUrls().find(url => new URL(url).searchParams.get('cursor') === cursorBeforeDisconnect);
    expect(reconnectUrl).toBeDefined();
    expect(new URL(reconnectUrl!).searchParams.get('cursor')).toBe(cursorBeforeDisconnect);

    // Publish through the same loopback command route the CLI uses, authenticated by the bearer.
    const revisionText = 'Revised while the browser stream was disconnected';
    const published = await sendControlCommand(server, 'goal.revise', { goalId: 'goal-browser', expectedRevision: 1, change: revisionText }, 1);
    expect(published.status).toBe(200);
    expect(published.body.state).toBe('terminal');
    expect(published.body.result).toMatchObject({ goal_id: 'goal-browser', revision: 2, spec: { text: revisionText } });
    // The browser is still disconnected, so the event has not reached the UI yet.
    await expect(eventPanel.locator('.row', { hasText: 'control.goal.revise' })).toHaveCount(0);

    await page.unroute('**/api/v1/events/stream*');
    // EventSource retries automatically at its retained cursor; the successful recovery request
    // must still carry the exact pre-disconnect cursor, and replay the event published meanwhile.
    const streamsBeforeRecovery = streamRequests.length;
    await expect(page.locator('.app-bar')).toContainText('live', { timeout: 30_000 });
    const recoveredUrl = streamRequests.slice(streamsBeforeRecovery).find(url => new URL(url).searchParams.get('cursor') === cursorBeforeDisconnect);
    expect(recoveredUrl).toBeDefined();
    const replayed = eventPanel.locator('.row', { hasText: 'control.goal.revise' });
    await expect(replayed).toBeVisible({ timeout: 20_000 });
    // The replayed frame is the exact command published during the outage, not an older event.
    await expect(replayed).toContainText(published.requestId);
    const replayedSeq = Number((await replayed.locator('.row-time').innerText()).replace('#', ''));
    expect(replayedSeq).toBeGreaterThan(cursorValue);
    await expect.poll(async () => Number((await snapshotCursor.innerText()).trim()), { timeout: 20_000 }).toBeGreaterThan(cursorValue);
    // One missed event fits the replay budget: no gap is expected, and none is shown.
    await expect(page.locator('.notice', { hasText: 'Event stream gap' })).toHaveCount(0);

    // The replayed snapshot also carries the revised goal state.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await expect(panel(page, 'Goals').locator('.row', { hasText: 'goal-browser' })).toContainText(`revision 2 · ${revisionText}`);

    // A network outage is a real disconnect: the paired HttpOnly session survives it and the
    // control surface reconnects after the browser comes back online.
    await page.context().setOffline(true);
    await expect(page.reload()).rejects.toThrow();
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toHaveCount(0);
    await expect(page.locator('.app-bar')).toContainText('live');
    await expect(page.locator('.hero-explain')).toContainText(revisionText);
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

    // Neither credential ever appears in the attach transcript. This bearer-only attach never
    // obtains the session cookie/CSRF token; the pairing-code attach case below proves that
    // path separately.
    expect(cli.transcript).not.toContain(server.cliBearer);
  } finally {
    await cli.close();
    await server.stop();
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('rejected command shows a visible error and is not recorded as accepted', async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await pairBrowser(page, server.pairingCode);

    // Pausing makes the ControlService reject message writes with a 400/rejected receipt while
    // the browser still offers the action, exercising the real command-error path.
    await page.getByRole('button', { name: 'Conversation' }).click();
    const resumeButton = page.getByRole('button', { name: 'Resume' });
    await expect(resumeButton).toBeDisabled();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.notice', { hasText: /pause: terminal/ })).toBeVisible();
    await expect.poll(async () => (await browserStatus(page)).body.paused).toBe(true);
    await expect(resumeButton).toBeEnabled();

    const rejectedText = 'This message must be rejected while paused';
    await page.getByLabel('Message to agent').fill(rejectedText);
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeEnabled();
    await send.click();

    // The rejection is an operator-visible error state, not only an HTTP status.
    const error = page.getByTestId('command-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('paused');
    await expect(page.locator('.notice', { hasText: /message: terminal/ })).toHaveCount(0);
    await expect(panel(page, 'Conversation').locator('.row', { hasText: rejectedText }).locator('.tag')).toHaveText('rejected');

    // The rejected command did not unpause or otherwise mutate the Runtime.
    expect((await browserStatus(page)).body.paused).toBe(true);
    // The rejected command produced no execution and no effect. Absence is shown as unknown,
    // not as a successful empty result.
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(panel(page, 'Executions')).toContainText('No executions yet.');
    await expect(panel(page, 'Effects')).toContainText('No effects recorded.');
    // The error survives at least one periodic read; it must not be silently cleared by refresh.
    await page.waitForTimeout(3_000);
    await expect(error).toBeVisible();
    await expect(error).toContainText('paused');

    // A subsequent successful command clears the error state and the action guard returns.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.notice', { hasText: /resume: terminal/ })).toBeVisible();
    await expect(error).toHaveCount(0);
    await expect.poll(async () => (await browserStatus(page)).body.paused).toBe(false);
    await expect(resumeButton).toBeDisabled();
  } finally {
    await server.stop();
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('pairing-code attach exercises session/CSRF auth without leaking either credential', async () => {
  const server = await startServer();
  const cli = await AttachClient.startWithPairCode(server.url, server.pairingCode);
  try {
    await cli.waitSubscription('open');
    // The pair receipt arrives before any command; consume it so the next command is really sent.
    const startup = cli.takeResponses();
    expect(startup).toContainEqual(expect.objectContaining({ paired: true }));

    // A write proves the CLI really exchanged the code for an HttpOnly session and CSRF token;
    // a rejected pairing would leave this command unauthenticated and fail.
    const set = await cli.command('goal set paired-goal Paired CLI write') as { state: string };
    expect(set.state).toBe('terminal');
    const shown = await cli.command('goal show paired-goal') as Array<{ revision: number }>;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.revision).toBe(1);

    // The pairing code, session cookie, CSRF token and cookie header never appear in output.
    expect(cli.transcript).not.toContain(server.pairingCode);
    expect(cli.transcript).not.toContain('furevercraft_session');
    expect(cli.transcript).not.toContain('furevercraft.csrf');
    expect(cli.transcript).not.toContain('csrfToken');
    expect(cli.transcript).not.toContain('set-cookie');
  } finally {
    await cli.close();
    await server.stop();
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('public serve CLI uses an isolated db/port, honors pairing modes and shuts down cleanly', async () => {
  const paired = await startServe({ profile: 'simulated', pairingCode: 'serve-pair-e2e', cliBearer: 'serve-bearer-e2e' });
  try {
    expect(paired.ready).toMatchObject({
      listening: paired.url,
      profile: 'simulated',
      db: paired.db,
      pairing: true,
      cliAccess: 'bearer-configured',
    });
    expect(String(paired.ready.webRoot)).toMatch(/dist[\\/]web$/);
    expect(Number(new URL(paired.url).port)).toBeGreaterThan(0);

    const bearerStatus = await fetch(`${paired.url}/api/v1/status`, { headers: { authorization: `Bearer ${paired.cliBearer!}` } });
    expect(bearerStatus.status).toBe(200);
    expect(await bearerStatus.json()).toMatchObject({ paused: false });
    // Pairing is enforced: the same read without a bearer or paired session is refused.
    expect((await fetch(`${paired.url}/api/v1/status`)).status).toBe(401);
    // The explicit pairing code and bearer are never repeated in the startup output.
    expect(paired.logs.stdout).not.toContain('serve-pair-e2e');
    expect(paired.logs.stdout).not.toContain('serve-bearer-e2e');
  } finally {
    const exit = await paired.stop();
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(isProcessAlive(paired.pid)).toBe(false);
    expect(temporaryStateExists(paired.dir)).toBe(false);
  }

  // --no-pairing with no bearer is an explicit loopback-open development mode, and the 3D
  // profile is assembled by the public CLI rather than a test-only in-process factory.
  const open = await startServe({ profile: 'simulated-3d', pairing: false });
  try {
    expect(open.ready).toMatchObject({ listening: open.url, profile: 'simulated-3d', db: open.db, pairing: false, cliAccess: 'loopback-open' });
    expect(Number(new URL(open.url).port)).toBeGreaterThan(0);
    const response = await fetch(`${open.url}/api/v1/status`);
    expect(response.status).toBe(200);
    const status = await response.json() as { paused?: boolean; observation?: { mode?: string }; body?: { mode?: string; threeDimensional?: boolean; z?: number } };
    expect(status.paused).toBe(false);
    expect(status.observation).toMatchObject({ mode: '3d' });
    expect(status.body).toMatchObject({ mode: '3d', threeDimensional: true });
    expect(typeof status.body?.z).toBe('number');
  } finally {
    const exit = await open.stop();
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(isProcessAlive(open.pid)).toBe(false);
    expect(temporaryStateExists(open.dir)).toBe(false);
  }
});

test('token mode (no pairing, CLI bearer) shows a truthful browser-disabled message and rejects writes', async ({ page }) => {
  const bearer = 'token-mode-browser-e2e-bearer';
  const server = await startServe({ profile: 'simulated', pairing: false, cliBearer: bearer });
  try {
    expect(server.ready).toMatchObject({ pairing: false, cliAccess: 'bearer-configured' });
    expect(server.pairingCode).toBeUndefined();

    const authMode = await page.request.get(`${server.url}/api/v1/auth-mode`);
    expect(authMode.status()).toBe(200);
    const mode = await authMode.json() as Record<string, unknown>;
    expect(mode).toMatchObject({ mode: 'bearer-only', pairing: false, bearerRequired: true, browserAccess: 'disabled' });
    // The bootstrap surface is public but never carries the bearer or another secret.
    const modeText = JSON.stringify(mode);
    expect(modeText).not.toContain(bearer);
    expect(modeText).not.toContain('csrf');
    expect(modeText).not.toContain('session');

    await page.goto(server.url);

    // A 401 in token mode must not open a pairing dialog or point at a code that will never
    // be issued; the UI states the actual enforcement mode instead.
    await expect(page.getByTestId('bearer-mode-notice')).toBeVisible();
    await expect(page.getByTestId('bearer-mode-notice')).toContainText('Browser access disabled; use the CLI bearer');
    await expect(page.getByTestId('bearer-mode-notice')).toContainText('token mode');
    await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pair', exact: true })).toHaveCount(0);
    await expect(page.getByText(/restart the service to issue a new one/)).toHaveCount(0);

    // The mode endpoint grants nothing: unauthenticated browser reads and writes are refused
    // with the token-mode error, and the write never reaches the Runtime.
    const unauthenticated = await page.evaluate(async () => {
      const read = await fetch('/api/v1/status');
      const write = await fetch('/api/v1/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'e2e-token-mode-write', command: 'pause', payload: {} }),
      });
      return {
        readStatus: read.status, readBody: await read.json(),
        writeStatus: write.status, writeBody: await write.json(),
      };
    });
    expect(unauthenticated.readStatus).toBe(401);
    expect(unauthenticated.readBody).toMatchObject({ error: { code: 'bearer-required' } });
    expect(unauthenticated.writeStatus).toBe(401);
    expect(unauthenticated.writeBody).toMatchObject({ error: { code: 'bearer-required' } });

    const bearerStatus = await fetch(`${server.url}/api/v1/status`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(bearerStatus.status).toBe(200);
    expect(await bearerStatus.json()).toMatchObject({ paused: false });

    // A UI action is visibly refused rather than painted as a success, and still no pairing
    // dialog appears.
    await page.getByRole('button', { name: 'Conversation' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    const error = page.getByTestId('command-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('browser access disabled; use the CLI bearer');
    await expect(page.locator('.notice', { hasText: /pause: terminal/ })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toHaveCount(0);
    const afterAttempt = await fetch(`${server.url}/api/v1/status`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(await afterAttempt.json()).toMatchObject({ paused: false });

    // The bearer never appears in the served page or in its own bootstrap/error state.
    expect(await page.content()).not.toContain(bearer);
    expect(server.logs.stdout).not.toContain(bearer);
  } finally {
    await page.close();
    const exit = await server.stop();
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('simulated-3d browser view shows a real z pose and pairing errors stay visible', async ({ browser }) => {
  const server = await startServe({ profile: 'simulated-3d', pairingCode: 'browser-3d-pair' });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.url);
    const dialog = page.getByRole('dialog', { name: 'Pair this browser' });
    await expect(dialog).toBeVisible();

    // A wrong code is a visible error, and the dialog stays open for a retry.
    await page.getByLabel('Pairing code').fill('not-the-code');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /pairing-code-invalid/ })).toBeVisible();
    await expect(dialog).toBeVisible();

    await page.getByLabel('Pairing code').fill(server.pairingCode!);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.app-bar')).toContainText('live');

    // The assembled runtime profile is reported separately from the attached body/server id:
    // simulated-3d is the runtime that was built, not a claim that a real 3D client is attached.
    const heroMeta = page.locator('.hero-meta');
    await expect(heroMeta.getByTestId('runtime-profile')).toHaveText('runtime profile simulated-3d');
    await expect(heroMeta.getByTestId('server-profile')).toHaveText('server profile simulated');

    // The 3D body contract is a real simulated-body observation: mode 3d and a z coordinate,
    // never a legacy planar position relabelled as three-dimensional.
    const observation = panel(page, 'Observation evidence');
    const contract = observation.locator('.kv-row', { hasText: 'Body contract' });
    await expect(contract).toContainText('3d');
    await expect(observation.getByTestId('body-mode')).toHaveText('3d');
    await expect(contract).toContainText('current');
    await expect(observation.locator('.kv-row', { hasText: 'World pose x / y / z' })).toContainText('0.5, 0, 0.5');
    await expect(observation.locator('.kv-row', { hasText: 'Dimension' })).toContainText('overworld');
    await expect(observation.locator('.kv-row', { hasText: 'Legacy planar position' })).toHaveCount(0);

    // Raw and effective input gates are labelled separately, both open for this profile.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('raw-inputs')).toHaveText('yes');
    await expect(page.getByTestId('effective-inputs')).toContainText('enabled');

    // The same single-use code replayed from a fresh browser is a visible error, not a bypass.
    const replayContext = await browser.newContext();
    const replayPage = await replayContext.newPage();
    try {
      await replayPage.goto(server.url);
      await replayPage.getByLabel('Pairing code').fill(server.pairingCode!);
      await replayPage.getByRole('button', { name: 'Pair', exact: true }).click();
      await expect(replayPage.getByRole('alert').filter({ hasText: /pairing-used/ })).toBeVisible();
      await expect(replayPage.getByRole('dialog', { name: 'Pair this browser' })).toBeVisible();
    } finally {
      await replayContext.close();
    }
  } finally {
    await context.close();
    const exit = await server.stop();
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('capabilities render raw and effective input control separately', async ({ page }) => {
  const server = await startServer();
  let injectRevoked = false;
  await page.route('**/api/v1/capabilities', async route => {
    if (!injectRevoked) return route.continue();
    // The disabled/control-revoked shape is the documented ControlService contract. An in-process
    // serve has no bridge service to revoke admission, so this browser test supplies that read
    // to prove the web does not collapse effective state into the raw configured gate.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile: 'simulated',
        inputsEnabled: true,
        effectiveInputsEnabled: false,
        inputControl: { open: false, state: 'disabled', reason: 'control-revoked' },
        bridge: {},
        skills: [],
        limitations: ['provider-unavailable'],
      }),
    });
  });
  try {
    await page.goto(server.url);
    await pairBrowser(page, server.pairingCode);
    injectRevoked = true;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('raw-inputs')).toHaveText('yes');
    await expect(page.getByTestId('effective-inputs')).toContainText('disabled');
    await expect(page.getByTestId('effective-inputs')).toContainText('control-revoked');
  } finally {
    await page.unroute('**/api/v1/capabilities');
    await server.stop();
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});

test('provider-unavailable turns show a warning, not a green terminal receipt', async ({ page }) => {
  const server = await startServe({ profile: 'simulated', pairingCode: 'provider-unavailable-pair' });
  try {
    await page.goto(server.url);
    await pairBrowser(page, server.pairingCode!);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(panel(page, 'Provider and config').locator('.kv-row', { hasText: 'Transport' })).toContainText('unavailable');

    await page.getByRole('button', { name: 'Conversation' }).click();
    const prompt = 'Report current status';
    await page.getByLabel('Message to agent').fill(prompt);
    await page.getByRole('button', { name: 'Send message' }).click();

    // The command receipt is terminal, but the turn itself is not a success.
    const warning = page.getByTestId('turn-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('unavailable');
    await expect(warning).toContainText('No successful response was recorded');
    await expect(page.locator('.notice', { hasText: /message: terminal/ })).toHaveCount(0);
    const turn = panel(page, 'Conversation').locator('.row', { hasText: prompt });
    await expect(turn.locator('.tag')).toHaveText('unavailable');
    await expect(turn.locator('.tag')).toHaveClass(/warn/);
    await expect(turn.locator('.tag')).not.toHaveClass(/ok/);

    // An unavailable turn produces no execution or effect to confirm.
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(panel(page, 'Executions')).toContainText('No executions yet.');
    await expect(panel(page, 'Effects')).toContainText('No effects recorded.');
  } finally {
    // Close the browser stream before asking the public serve process to shut down; an open
    // EventSource would otherwise keep reconnecting while server.close() drains.
    await page.close();
    const exit = await server.stop();
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
  }
  expect(isProcessAlive(server.pid)).toBe(false);
  expect(temporaryStateExists(server.dir)).toBe(false);
});
