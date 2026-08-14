/**
 * Starts a real `wrangler dev` (workerd) instance for the integration suite and
 * shuts it down afterwards. Nothing is mocked: the tests hit the actual Worker
 * router, Durable Object, storage and alarms.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = Number(process.env['SET_TEST_PORT'] ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 90_000;

let child: ChildProcess | null = null;

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child != null && child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('wrangler dev did not become healthy in time');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function setup(): Promise<void> {
  process.env['SET_TEST_BASE_URL'] = BASE_URL;
  child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', () => {
    /* discard: wrangler is chatty and the suite asserts on HTTP, not logs */
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  try {
    await waitForHealth();
  } catch (error) {
    process.stderr.write(stderr.join(''));
    throw error;
  }
}

export async function teardown(): Promise<void> {
  if (child?.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
