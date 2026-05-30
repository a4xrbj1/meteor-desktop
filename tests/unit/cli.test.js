import * as chai from 'chai';
import { Command } from 'commander';

import { addOptions, registerCommands } from '../../lib/bin/cli.js';

const { describe, it } = global;
const { expect } = chai;

/**
 * Parses an argv tail through a fresh commander program configured exactly like the real CLI,
 * with spy action handlers, and reports which command was dispatched and with what ddp_url.
 * This exercises the real option + command graph (including the `run` default command) without
 * running any build work.
 *
 * @param {Array<String>} args - the argv tail after `node meteor-desktop`
 * @returns {{action: (String|null), ddp: *}}
 */
const route = (args) => {
    const program = new Command();
    addOptions(program);
    const fired = { action: null, ddp: undefined };
    const make = (name) => (ddp) => {
        fired.action = name;
        fired.ddp = ddp;
    };
    registerCommands(program, {
        init: make('init'),
        run: make('run'),
        build: make('build'),
        buildInstaller: make('build-installer'),
        justRun: make('just-run'),
        runPackager: make('package'),
        initTestsSupport: make('init-tests-support')
    });
    program.exitOverride();
    program.parse(['node', 'meteor-desktop', ...args]);
    return fired;
};

describe('cli argv routing', () => {
    it('routes global-options-before-build (seed meteor-desktop-e7c2 repro) to build with no ddp_url', () => {
        const r = route([
            '--build-meteor', '--production', '--meteor-settings', 'x.json', 'build', '--ignore-stderr', 'W'
        ]);
        expect(r.action).to.equal('build');
        expect(r.ddp).to.equal(undefined);
    });

    it('routes build-before-options (current frontend desktop script) to build with no ddp_url', () => {
        const r = route([
            'build', '--build-meteor', '--production', '--meteor-settings', 'x.json', '--ignore-stderr', 'W'
        ]);
        expect(r.action).to.equal('build');
        expect(r.ddp).to.equal(undefined);
    });

    it('routes no arguments to the default run command', () => {
        const r = route([]);
        expect(r.action).to.equal('run');
        expect(r.ddp).to.equal(undefined);
    });

    it('routes run with a flag to run', () => {
        const r = route(['run', '--debug']);
        expect(r.action).to.equal('run');
        expect(r.ddp).to.equal(undefined);
    });

    it('routes a bare build subcommand to build', () => {
        const r = route(['build']);
        expect(r.action).to.equal('build');
        expect(r.ddp).to.equal(undefined);
    });

    it('routes a bare ddp url to the default run command as its ddp_url', () => {
        const r = route(['http://foo:3000']);
        expect(r.action).to.equal('run');
        expect(r.ddp).to.equal('http://foo:3000');
    });

    it('routes init-tests-support to its own command', () => {
        const r = route(['init-tests-support']);
        expect(r.action).to.equal('init-tests-support');
    });
});
