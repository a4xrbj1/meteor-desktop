// This propagates the version from package.json to Meteor plugins.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));

const paths = ['./plugins/bundler/package.js', './plugins/watcher/package.js'];
paths.forEach((path) => {
    let packageJs = fs.readFileSync(path, 'UTF-8');
    packageJs = packageJs.replace(/(version: ')([^']+)'/, `$1${version}'`);
    if (~path.indexOf('watcher')) {
        packageJs = packageJs.replace(/(communitypackages:meteor-desktop-bundler@)([^']+)'/, `$1${version}'`);
    }
    fs.writeFileSync(path, packageJs);
});
