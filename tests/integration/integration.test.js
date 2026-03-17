import * as chai from 'chai';
import dirty from 'dirty-chai';
import fs from 'fs';
import path from 'path';

import paths from '../helpers/paths.js';
import addScript from '../../lib/scripts/utils/addScript.js';

chai.use(dirty);
const { describe, it } = global;
const { expect } = chai;

let appDir = '';

describe('desktop', () => {
    before(() => {
        appDir = path.join(paths.testsIntegrationTmpPath, 'test-desktop');
    });

    beforeEach(() => {
        try {
            fs.unlinkSync('meteor.log');
        } catch {
            // No worries...
        }
    });

    describe('add to scripts', () => {
        it('should add a desktop entry in package.json', () => {
            const packageJsonPath = path.join(appDir, 'package.json');
            const original = fs.readFileSync(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(original);
            delete packageJson.scripts.desktop;
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

            addScript('desktop', 'meteor-desktop', packageJsonPath, () => {
                throw new Error('addScript failed');
            });

            const result = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            expect(result.scripts.desktop).to.be.equal('meteor-desktop');
            fs.writeFileSync(packageJsonPath, original);
        });
    });
});
