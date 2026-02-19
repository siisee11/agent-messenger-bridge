#!/usr/bin/env bun

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import solidPlugin from '../node_modules/@opentui/solid/scripts/solid-plugin';

declare const Bun: any;

type Target = {
  os: 'darwin' | 'linux' | 'windows';
  arch: 'x64' | 'arm64';
  baseline?: boolean;
  abi?: 'musl';
};

const root = resolve(import.meta.dirname, '..');
const outRoot = join(root, 'dist', 'release');
const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string;
};

const allTargets: Target[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'x64', baseline: true },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'x64', baseline: true },
  { os: 'linux', arch: 'arm64', abi: 'musl' },
  { os: 'linux', arch: 'x64', abi: 'musl' },
  { os: 'linux', arch: 'x64', baseline: true, abi: 'musl' },
  { os: 'windows', arch: 'x64' },
  { os: 'windows', arch: 'x64', baseline: true },
];

const single = process.argv.includes('--single');
const platformMap: Record<NodeJS.Platform, Target['os'] | undefined> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  netbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
};
const currentOs = platformMap[process.platform];
const currentArch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : undefined;
const targets =
  single && currentOs && currentArch
    ? allTargets.filter((t) => t.os === currentOs && t.arch === currentArch && !t.baseline && !t.abi)
    : allTargets;

if (targets.length === 0) {
  throw new Error('No matching build targets found.');
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const binaries: Record<string, string> = {};

for (const target of targets) {
  const suffix = [target.os, target.arch, target.baseline ? 'baseline' : undefined, target.abi]
    .filter(Boolean)
    .join('-');
  const packageName = `@siisee11/discode-${suffix}`;
  const compileTarget = `bun-${suffix}`;
  const packageDir = join(outRoot, packageName.replace('@siisee11/', ''));
  const binDir = join(packageDir, 'bin');
  const binaryName = target.os === 'windows' ? 'discode.exe' : 'discode';
  const outfile = join(binDir, binaryName);

  console.log(`Building ${packageName} (${compileTarget})`);
  mkdirSync(binDir, { recursive: true });

  const result = await Bun.build({
    plugins: [solidPlugin],
    entrypoints: ['./bin/discode.ts', './bin/tui.tsx'],
    target: 'bun',
    sourcemap: 'external',
    compile: {
      target: compileTarget as any,
      outfile,
      windows: {},
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: true,
      autoloadTsconfig: true,
      execArgv: ['--'],
    },
    define: {
      DISCODE_VERSION: `'${pkgJson.version}'`,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Build failed for ${packageName}`);
  }

  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: packageName,
        version: pkgJson.version,
        os: [target.os === 'windows' ? 'win32' : target.os],
        cpu: [target.arch],
        license: 'MIT',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  // Copy resource files (plugin scripts, hooks) alongside the binary
  const resourcesDir = join(packageDir, 'resources');
  cpSync(join(root, 'src', 'claude', 'plugin'), join(resourcesDir, 'claude-plugin'), { recursive: true });
  cpSync(join(root, 'src', 'opencode', 'plugin'), join(resourcesDir, 'opencode-plugin'), { recursive: true });
  cpSync(join(root, 'src', 'gemini', 'hook'), join(resourcesDir, 'gemini-hook'), { recursive: true });
  cpSync(join(root, 'src', 'container', 'chrome-mcp-bridge.cjs'), join(resourcesDir, 'chrome-mcp-bridge.cjs'));

  binaries[packageName] = pkgJson.version;
}

const manifestPath = join(outRoot, 'manifest.json');
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify({ binaries }, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${manifestPath}`);
