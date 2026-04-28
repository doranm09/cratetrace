#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(EXT_DIR, 'bin');
const DIST_DIR = path.join(EXT_DIR, 'dist');
const PACKAGE_JSON_PATH = path.join(EXT_DIR, 'package.json');

const TARGETS = {
  'win32-x64': { rustTarget: 'x86_64-pc-windows-msvc', exe: '.exe' },
  'win32-arm64': { rustTarget: 'aarch64-pc-windows-msvc', exe: '.exe' },
  'linux-x64': { rustTarget: 'x86_64-unknown-linux-gnu', exe: '' },
  'linux-arm64': { rustTarget: 'aarch64-unknown-linux-gnu', exe: '' },
  'linux-armhf': { rustTarget: 'armv7-unknown-linux-gnueabihf', exe: '' },
  'alpine-x64': { rustTarget: 'x86_64-unknown-linux-musl', exe: '' },
  'alpine-arm64': { rustTarget: 'aarch64-unknown-linux-musl', exe: '' },
  'darwin-x64': { rustTarget: 'x86_64-apple-darwin', exe: '' },
  'darwin-arm64': { rustTarget: 'aarch64-apple-darwin', exe: '' }
};

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const cmdForLog = [cmd, ...args].join(' ');
  console.log(`> ${cmdForLog}`);
  const result = cp.spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    fail(`Command failed: ${cmdForLog}`);
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

function resolveTarget() {
  const target = readArg('--target') || process.env.VSCE_TARGET;
  if (!target) {
    fail('Missing --target (example: --target linux-x64).');
  }

  const config = TARGETS[target];
  if (!config) {
    const supported = Object.keys(TARGETS).sort().join(', ');
    fail(`Unsupported --target '${target}'. Supported targets: ${supported}`);
  }

  return { target, ...config };
}

function binaryName(exeSuffix) {
  return `cratetrace-cli${exeSuffix}`;
}

function sourceBinaryPath(rustTarget, exeSuffix) {
  return path.join(ROOT, 'target', rustTarget, 'release', binaryName(exeSuffix));
}

function bundledBinaryPath(exeSuffix) {
  return path.join(BIN_DIR, binaryName(exeSuffix));
}

function ensureBundledBinary(target, exeSuffix) {
  const bundledPath = bundledBinaryPath(exeSuffix);
  if (!fs.existsSync(bundledPath)) {
    fail(
      `Missing bundled CLI for ${target}: expected ${path.relative(EXT_DIR, bundledPath)}.`
    );
  }

  const stats = fs.statSync(bundledPath);
  if (!stats.isFile() || stats.size <= 0) {
    fail(
      `Bundled CLI for ${target} is invalid: ${path.relative(EXT_DIR, bundledPath)}.`
    );
  }

  return bundledPath;
}

function buildAndBundle() {
  const { target, rustTarget, exe } = resolveTarget();
  run('cargo', ['build', '--release', '-p', 'cratetrace-cli', '--target', rustTarget]);

  const sourcePath = sourceBinaryPath(rustTarget, exe);
  if (!fs.existsSync(sourcePath)) {
    fail(
      `Expected built binary is missing for ${target}: ${path.relative(ROOT, sourcePath)}.`
    );
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const destinationPath = bundledBinaryPath(exe);
  fs.copyFileSync(sourcePath, destinationPath);
  if (exe === '') {
    fs.chmodSync(destinationPath, 0o755);
  }

  console.log(
    `Bundled ${path.relative(ROOT, sourcePath)} -> ${path.relative(EXT_DIR, destinationPath)}`
  );
}

function validateBundle() {
  const { target, exe } = resolveTarget();
  const bundledPath = ensureBundledBinary(target, exe);
  console.log(`Validated bundled CLI for ${target}: ${path.relative(EXT_DIR, bundledPath)}`);
}

function packageTarget() {
  const { target, exe } = resolveTarget();
  ensureBundledBinary(target, exe);

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const outputName = `cratetrace-${pkg.version}-${target}.vsix`;
  fs.mkdirSync(DIST_DIR, { recursive: true });

  run('npx', ['vsce', 'package', '--target', target, '--out', path.join('dist', outputName)], {
    cwd: EXT_DIR
  });

  console.log(`Created ${path.join('dist', outputName)}`);
}

function releaseTarget() {
  buildAndBundle();
  validateBundle();
  packageTarget();
}

const command = process.argv[2];

switch (command) {
  case 'bundle':
    buildAndBundle();
    break;
  case 'validate':
    validateBundle();
    break;
  case 'package':
    packageTarget();
    break;
  case 'release':
    releaseTarget();
    break;
  default:
    fail('Usage: node scripts/release.js <bundle|validate|package|release> --target <vsce-target>');
}
