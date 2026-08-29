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
const runViaBinSymlink = (args, cwd) => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bin-'));
    const link = path.join(binDir, 'meteor-desktop');
    fs.symlinkSync(realCli, link);
    const result = spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', cwd });
    fs.rmSync(binDir, { recursive: true, force: true });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
};

describe('cli binary entry (.bin symlink)', () => {
    it('runs and prints --version when invoked through a .bin symlink', () => {
        const r = runViaBinSymlink(['--version']);
        expect(r.status).to.equal(0);
        expect(r.stdout.trim()).to.equal(version);
    });

    // The CLI printed "not in a meteor app dir" and then exited 0, because a bare process.exit()
    // takes process.exitCode, which is 0. A script driving the CLI could not tell that refusal from
    // a successful build (seed meteor-desktop-a8f8). Inversion: put the bare exit() back and the
    // status is 0.
    it('fails with a non-zero status when run outside a meteor app', () => {
        const notAnApp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-not-an-app-'));
        try {
            const r = runViaBinSymlink(['build'], notAnApp);
            expect(r.status).to.equal(1);
            expect(`${r.stdout}${r.stderr}`).to.contain('not in a meteor app dir');
        } finally {
            fs.rmSync(notAnApp, { recursive: true, force: true });
        }
    });

    // The behavioural contract the whole seed is about: when a command fails part-way, the shell
    // hears about it rather than seeing a 0. A .meteor dir gets past the isMeteorApp gate, then
    // the missing package.json makes `getDependency` bail. This used to drive `package`, which was
    // removed with electron-packager (seed meteor-desktop-a493); `just-run` fails at the same
    // point for the same reason. Inversion: make that guard `process.exit()` instead of
    // `process.exit(1)` and the status is 0.
    // NOT covered here, and worth knowing: this path exits from inside `getDependency`, so it does
    // NOT exercise the CLI's `reportAndExit` handler, despite what this comment used to claim.
    it('exits non-zero when a command fails before doing its work', () => {
        const halfAnApp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-half-app-'));
        fs.mkdirSync(path.join(halfAnApp, '.meteor'));
        try {
            const r = runViaBinSymlink(['just-run'], halfAnApp);
            expect(r.status).to.not.equal(0);
        } finally {
            fs.rmSync(halfAnApp, { recursive: true, force: true });
        }
    });

    // The `package` command was removed with electron-packager (seed meteor-desktop-a493), but it
    // cannot simply vanish: `run [ddp_url]` is commander's default command, so a bare `package`
    // would be swallowed as a ddp_url and the app would launch against a nonsense URL. This drives
    // the real .bin symlink, i.e. exactly what `npm run desktop -- package` reaches. Inversion:
    // delete the tombstone from registerCommands and the status is 0.
    it('refuses the removed `package` command instead of treating it as a ddp_url', () => {
        const notAnApp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-removed-pkg-'));
        fs.mkdirSync(path.join(notAnApp, '.meteor'));
        try {
            const r = runViaBinSymlink(['package'], notAnApp);
            expect(r.status).to.equal(1);
            expect(`${r.stdout}${r.stderr}`).to.contain('`package` command was removed');
        } finally {
            fs.rmSync(notAnApp, { recursive: true, force: true });
        }
    });

    // This path used to exit 0 on purpose - "Do not fail, so that npm will not print his error
    // stuff to console" - which made a refusal indistinguishable from a successful build for any
    // script driving the CLI, the exact defect seed meteor-desktop-a8f8 closed elsewhere. The npm
    // rationale is stale: on npm 12.0.2 a failing script prints two `npm notice` lines and no
    // error block at all. `run` reaches the same guard, since it is `build(true)`. Inversion:
    // restore `process.exit(0)` in electronApp.js and the status is 0 (verified, seed
    // meteor-desktop-a86c).
    it('exits non-zero when the .desktop dir is missing', () => {
        const noDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'md-no-desktop-'));
        fs.mkdirSync(path.join(noDesktop, '.meteor'));
        try {
            const r = runViaBinSymlink(['build'], noDesktop);
            expect(r.status).to.equal(1);
            expect(`${r.stdout}${r.stderr}`).to.contain('you do not have a .desktop dir');
        } finally {
            fs.rmSync(noDesktop, { recursive: true, force: true });
        }
    });
});
