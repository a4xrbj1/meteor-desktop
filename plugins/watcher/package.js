/* eslint-disable prefer-arrow-callback */
Package.describe({
    name: 'a4xrbj1:meteor-desktop-watcher',
    version: '5.1.0',
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
        'a4xrbj1:meteor-desktop-bundler@5.1.0',
    ], ['server'], {
        weak: true
    });
    api.addFiles([
        'watcher.js'
    ], 'server');
});
