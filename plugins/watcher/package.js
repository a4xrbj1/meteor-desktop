/* eslint-disable prefer-arrow-callback */
Package.describe({
    name: 'communitypackages:meteor-desktop-watcher',
    version: '4.0.0-rc.1',
    summary: 'Watches .desktop dir and triggers rebuilds on file change.',
    git: 'https://github.com/Meteor-Community-Packages/meteor-desktop',
    documentation: 'README.md',
    debugOnly: true
});

Npm.depends({
    chokidar: '3.5.3'
});

Package.onUse(function onUse(api) {
    api.versionsFrom('METEOR@3.0');
    api.use('ecmascript');
    api.use([
        'communitypackages:meteor-desktop-bundler@4.0.0-rc.1',
    ], ['server'], {
        weak: true
    });
    api.addFiles([
        'watcher.js'
    ], 'server');
});
