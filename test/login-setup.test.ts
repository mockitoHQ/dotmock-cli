import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { connectCliAuthSession } from '../src/commands/login.js';

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.DOTMOCK_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.DOTMOCK_API_URL;
  else process.env.DOTMOCK_API_URL = originalApiUrl;
});

test('setup login sends a heartbeat and resumes the browser-created session', async () => {
  process.env.DOTMOCK_API_URL = 'https://api.example.test';
  let requestedUrl = '';
  let requestedMethod = '';
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? 'GET';
    return new Response(
      JSON.stringify({
        userCode: 'ABCD1234',
        expiresIn: 600,
        interval: 3,
        connectedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const session = await connectCliAuthSession('setup/id');

  assert.equal(
    requestedUrl,
    'https://api.example.test/auth/cli/sessions/setup%2Fid/connect',
  );
  assert.equal(requestedMethod, 'POST');
  assert.equal(session.deviceCode, 'setup/id');
  assert.equal(session.userCode, 'ABCD1234');
});
