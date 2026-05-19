import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { detectCopilot } from '../src/agents/copilot-detector.js';

test('detectCopilot returns available metadata for a configured executable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-copilot-detector-'));
  try {
    const fakeBin = join(dir, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
    if (process.platform === 'win32') {
      writeFileSync(
        fakeBin,
        '@echo off\r\nif "%~1"=="--version" (\r\n  echo copilot 1.2.3\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n',
      );
    } else {
      writeFileSync(
        fakeBin,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "copilot 1.2.3"\n  exit 0\nfi\nexit 0\n',
      );
      chmodSync(fakeBin, 0o755);
    }

    const detected = await detectCopilot({ COPILOT_BIN: fakeBin });

    assert.deepEqual(detected, {
      available: true,
      path: fakeBin,
      version: 'copilot 1.2.3',
      models: [
        { id: 'default', label: 'Default (CLI config)' },
        { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
        { id: 'gpt-5.2', label: 'GPT-5.2' },
      ],
      promptViaStdin: true,
      streamFormat: 'copilot-stream-json',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
