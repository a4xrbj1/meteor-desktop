#!/usr/bin/env node
/**
 * Pre-publish smoke gate. Invokes the published CLI bin through a node_modules/.bin-style
 * symlink — exactly how npm runs it — and asserts it prints its --version. Guards against the
 * v6.0.17 regression class where a symlink-unsafe main-guard makes the CLI a silent no-op via
 * the symlink while running clean by realpath. Non-destructive: --version builds nothing.
 * Wired as `prepublishOnly`, so a no-op CLI can never be published regardless of discipline.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const realCli = path.resolve(path.join(here, '..', 'lib', 'bin', 'cli.js'));
const expected = JSON.parse(
    fs.readFileSync(path.resolve(path.join(here, '..', 'package.json')), 'utf-8')
).version;

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-smoke-'));
const link = path.join(binDir, 'meteor-desktop');
fs.symlinkSync(realCli, link);
const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
fs.rmSync(binDir, { recursive: true, force: true });

const out = (result.stdout || '').trim();
if (result.status !== 0 || out !== expected) {
    console.error(`prepublish-smoke FAILED: CLI via .bin symlink did not print v${expected}.`);
    console.error(`  exit=${result.status} stdout=${JSON.stringify(out)} stderr=${JSON.stringify((result.stderr || '').trim())}`);
    console.error('  This is the v6.0.17 symlink-main regression class — do not publish.');
    process.exit(1);
}
console.log(`prepublish-smoke OK: meteor-desktop v${out} runs via .bin symlink.`);
