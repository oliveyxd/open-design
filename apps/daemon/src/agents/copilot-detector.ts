import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createCommandInvocation,
  wellKnownUserToolchainBins,
} from '@open-design/platform';

const execFileP = promisify(execFile);

const DEFAULT_MODEL_OPTION = { id: 'default', label: 'Default (CLI config)' };
const fallbackModels = [
  DEFAULT_MODEL_OPTION,
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
];

const TOOLCHAIN_DIR_CACHE_TTL_MS = 5000;
let cachedToolchainHome: string | null = null;
let cachedToolchainDirs: string[] | null = null;
let cachedToolchainDirsAt = 0;

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function userToolchainDirs(): string[] {
  const homeOverride = process.env.OD_AGENT_HOME;
  const home = homeOverride || homedir();
  const now = Date.now();
  if (
    cachedToolchainHome === home &&
    cachedToolchainDirs &&
    now - cachedToolchainDirsAt < TOOLCHAIN_DIR_CACHE_TTL_MS
  ) {
    return cachedToolchainDirs;
  }

  cachedToolchainHome = home;
  cachedToolchainDirsAt = now;
  cachedToolchainDirs = wellKnownUserToolchainBins({
    home,
    includeSystemBins: process.platform !== 'win32' && !homeOverride,
    env: homeOverride ? {} : process.env,
  });
  return cachedToolchainDirs;
}

function resolvePathDirs(): string[] {
  const seen = new Set<string>();
  const dirs = [
    ...(process.env.PATH || '').split(delimiter),
    ...userToolchainDirs(),
  ];
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

function resolveOnPath(bin: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const dir of resolvePathDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (full && existsSync(full)) return full;
    }
  }
  return null;
}

function looksExecutableOnWindows(filePath: string): boolean {
  const ext = path.extname(filePath).trim().toUpperCase();
  if (!ext) return false;
  const executableExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return executableExts.includes(ext);
}

function configuredExecutableOverride(
  configuredEnv: Record<string, unknown> = {},
): string | null {
  const raw = configuredEnv.COPILOT_BIN;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const expanded = expandHomePath(raw.trim());
  if (!path.isAbsolute(expanded)) return null;

  try {
    if (!statSync(expanded).isFile()) return null;
    if (process.platform === 'win32') {
      if (!looksExecutableOnWindows(expanded)) return null;
    } else {
      accessSync(expanded, constants.X_OK);
    }
    return expanded;
  } catch {
    return null;
  }
}

function expandConfiguredEnv(
  configuredEnv: Record<string, unknown> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(configuredEnv)) {
    if (typeof value !== 'string') continue;
    env[key] = expandHomePath(value);
  }
  return env;
}

async function probeCopilotVersion(
  resolvedPath: string,
  configuredEnv: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    const probeEnv = {
      ...process.env,
      ...expandConfiguredEnv(configuredEnv),
    };
    const invocation = createCommandInvocation({
      command: resolvedPath,
      args: ['--version'],
      env: probeEnv,
    });
    const { stdout } = await execFileP(invocation.command, invocation.args, {
      env: probeEnv,
      timeout: 3000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const firstLine = stdout.trim().split('\n')[0] || '';
    return firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

export function resolveCopilotExecutable(
  configuredEnv: Record<string, unknown> = {},
): string | null {
  const configured = configuredExecutableOverride(configuredEnv);
  if (configured) return configured;
  return resolveOnPath('copilot');
}

export function buildCopilotArgs(
  extraAllowedDirs: string[] = [],
  options: { model?: string } = {},
): string[] {
  const args = ['--allow-all-tools', '--output-format', 'json'];
  if (options.model && options.model !== 'default') {
    args.push('--model', options.model);
  }
  const dirs = (extraAllowedDirs || []).filter(
    (d) => typeof d === 'string' && d.length > 0,
  );
  for (const d of dirs) args.push('--add-dir', d);
  return args;
}

export async function detectCopilot(
  configuredEnv: Record<string, unknown> = {},
): Promise<{
  available: boolean;
  path: string | null;
  version: string | null;
  models: Array<{ id: string; label: string }>;
  promptViaStdin: boolean;
  streamFormat: string;
}> {
  const resolved = resolveCopilotExecutable(configuredEnv);
  if (!resolved) {
    return {
      available: false,
      path: null,
      version: null,
      models: fallbackModels,
      promptViaStdin: true,
      streamFormat: 'copilot-stream-json',
    };
  }

  const version = await probeCopilotVersion(resolved, configuredEnv);

  return {
    available: true,
    path: resolved,
    version,
    models: fallbackModels,
    promptViaStdin: true,
    streamFormat: 'copilot-stream-json',
  };
}
