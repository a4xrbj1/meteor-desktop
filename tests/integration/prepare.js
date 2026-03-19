/* eslint-disable no-console */
// CI cache version: 2

import tempDir from 'temp-dir';
import fs from 'fs';
import path from 'path';

const testsTmpPath = path.resolve(path.join(tempDir, '.__tmp_int'));
const appDir = path.join(testsTmpPath, 'test-desktop');
const packageJsonPath = path.join(appDir, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
    console.log(`creating test dir in ${testsTmpPath}`);
    fs.mkdirSync(appDir, { recursive: true });
    const packageJson = {
        name: 'test-desktop',
        version: '1.0.0',
        scripts: {}
    };
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(`created minimal package.json at ${packageJsonPath}`);
} else {
    console.log(`test dir already exists at ${appDir}`);
}
