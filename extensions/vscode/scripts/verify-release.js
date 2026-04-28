#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(extensionRoot, 'package.json');

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

function ensureFile(relativePath) {
  const absolutePath = path.join(extensionRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
    return;
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    fail(`Required path is not a file: ${relativePath}`);
  }
}

function isPlaceholder(value) {
  if (typeof value !== 'string') {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized === 'todo' ||
    normalized === 'tbd' ||
    normalized === 'changeme' ||
    normalized === 'placeholder' ||
    normalized === 'local' ||
    normalized.includes('your-') ||
    normalized.includes('<') ||
    normalized.includes('>')
  );
}

function getRequired(object, keyPath) {
  const keys = keyPath.split('.');
  let current = object;

  for (const key of keys) {
    if (!current || !(key in current)) {
      fail(`Missing required manifest field: ${keyPath}`);
      return undefined;
    }
    current = current[key];
  }

  if (typeof current === 'string' && isPlaceholder(current)) {
    fail(`Manifest field ${keyPath} must not use a placeholder value (received: ${JSON.stringify(current)})`);
  }

  return current;
}

function verifyManifest() {
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const manifest = JSON.parse(raw);

  const requiredFields = [
    'name',
    'displayName',
    'description',
    'version',
    'publisher',
    'engines.vscode',
    'main',
  ];

  for (const field of requiredFields) {
    getRequired(manifest, field);
  }

  const activationEvents = getRequired(manifest, 'activationEvents');
  if (!Array.isArray(activationEvents) || activationEvents.length === 0) {
    fail('Manifest field activationEvents must be a non-empty array');
  }

  const commands = getRequired(manifest, 'contributes.commands');
  if (!Array.isArray(commands) || commands.length === 0) {
    fail('Manifest field contributes.commands must be a non-empty array');
  }
}

function verifyBundledCliExpectations() {
  const binDir = path.join(extensionRoot, 'bin');

  if (!fs.existsSync(binDir) || !fs.statSync(binDir).isDirectory()) {
    fail('Missing required directory: bin/');
    return;
  }

  const entries = fs.readdirSync(binDir).filter((name) => name !== '.gitignore');
  const allowed = new Set(['cratetrace-cli', 'cratetrace-cli.exe']);
  const bundleCandidates = entries.filter((name) => allowed.has(name));
  const unexpected = entries.filter((name) => !allowed.has(name));

  if (bundleCandidates.length !== 1) {
    fail('bin/ must contain exactly one platform bundle: cratetrace-cli or cratetrace-cli.exe');
  }

  for (const filename of bundleCandidates) {
    const filePath = path.join(binDir, filename);
    if (!fs.statSync(filePath).isFile()) {
      fail(`Bundled CLI entry is not a file: bin/${filename}`);
    }
  }

  if (unexpected.length > 0) {
    fail(`bin/ contains unexpected files: ${unexpected.join(', ')}`);
  }
}

for (const requiredFile of [
  'extension.js',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'media/mermaid.min.js',
]) {
  ensureFile(requiredFile);
}

verifyBundledCliExpectations();
verifyManifest();

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('✔ VS Code extension release verification passed.');
