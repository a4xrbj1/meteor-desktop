/* eslint-disable prefer-arrow-callback */
Package.describe({
    name: 'a4xrbj1:meteor-desktop-bundler',
    version: '5.1.2',
    summary: 'Bundles .desktop dir into desktop.asar.',
    git: 'https://github.com/a4xrbj1/meteor-desktop',
    documentation: 'README.md'
});

Package.registerBuildPlugin({
    name: 'meteor-desktop-bundler',
    use: ['ecmascript@0.16.1'],
    sources: ['bundler.js'],
    npmDependencies: { chokidar: '3.5.3' }
});

Package.onUse(function onUse(api) {
    api.versionsFrom('METEOR@3.0');
    api.use('isobuild:compiler-plugin@1.0.0');
    api.addFiles([
        'version._desktop_.js'
    ], 'server');
    api.export('METEOR_DESKTOP_VERSION', 'server');
});
