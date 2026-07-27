import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('production API defaults to the routed DotMock backend', () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dotmock-cli-config-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        "import('./src/config.ts').then(({ getBaseUrl }) => process.stdout.write(getBaseUrl()))",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: isolatedHome,
          DOTMOCK_API_URL: '',
        },
      },
    );

    assert.equal(output, 'https://dotmock.com/api');
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
