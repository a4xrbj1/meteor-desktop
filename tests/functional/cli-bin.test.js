import * as chai from 'chai';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const { describe, it } = global;
const { expect } = chai;

const dir = path.dirname(fileURLToPath(import.meta.url));
const realCli = path.resolve(path.join(dir, '..', '..', 'lib', 'bin', 'cli.js'));
const { version } = JSON.parse(
    fs.readFileSync(path.resolve(path.join(dir, '..', '..', 'package.json')), 'utf-8')
);

/**
 * Invokes the CLI through a node_modules/.bin-style symlink — exactly how npm runs it — and
 * returns the spawn result. Running lib/bin/cli.js by its realpath hides the v6.0.17 main-guard
 * regression (the isMain symlink mismatch); only the symlink entry path reproduces it.
 *
 * @param {Array<String>} args - argv tail passed to the CLI
 *
 * @returns {{status: (Number|null), stdout: String, stderr: String}}
 */
const runViaBinSymlink = (args) => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bin-'));
    const link = path.join(binDir, 'meteor-desktop');
    fs.symlinkSync(realCli, link);
    const result = spawnSync(process.execPath, [link, ...args], { encoding: 'utf8' });
    fs.rmSync(binDir, { recursive: true, force: true });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
};

describe('cli binary entry (.bin symlink)', () => {
    it('runs and prints --version when invoked through a .bin symlink', () => {
        const r = runViaBinSymlink(['--version']);
        expect(r.status).to.equal(0);
        expect(r.stdout.trim()).to.equal(version);
    });
});
