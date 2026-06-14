import { configs, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import globals from 'globals';

const FILES = [
    'lib/**/*.js',
    'scaffold/**/*.js',
    'skeleton/**/*.js',
    'tests/**/*.js',
];

export default [
    // Ignore patterns (replaces .eslintignore)
    {
        ignores: [
            '**/*{.,-}min.js',
            'tests/.__tmp/**',
            'tests/fixtures/**',
        ],
    },

    // Register plugins (import-x, @stylistic)
    airbnbPlugins.importX,
    airbnbPlugins.stylistic,

    // Spread base airbnb recommended configs
    ...configs.base.recommended,

    // Override/extend with project-specific settings
    {
        files: FILES,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.mocha,
                ...globals.meteor,
                // Custom project globals
                Meteor: 'readonly',
                WebAppLocalServer: 'readonly',
                Desktop: 'readonly',
                Profile: 'readonly',
                __METEOR_DESKTOP_BUNDLER: 'readonly',
            },
        },
        settings: {
            'import-x/core-modules': [
                'winston',
                'original-fs',
                'electron',
                'electron-debug',
                'rimraf',
                'process',
                'ava',
                'send',
                '@playwright/test',
            ],
        },
        rules: {
            // Style overrides
            // 150 matches the workspace-wide line-length convention (workspace CLAUDE.md);
            // the prior 120 was stricter than the code targets (most violations were 121–150).
            '@stylistic/max-len': ['error', { code: 150 }],
            // The project style is anonymous function expressions (`const f = function () {}`),
            // so airbnb-extended's func-names rule is counter to the documented convention.
            'func-names': 'off',
            // Dunder identifiers here are intentional: the Node ESM `__dirname` idiom
            // (path.dirname(fileURLToPath(import.meta.url))) and test seams (__setIpcForTest,
            // __setRendererForTest), plus Meteor's __meteor_runtime_config__.
            'no-underscore-dangle': 'off',
            // Several modules legitimately co-locate a primary class with a small helper class.
            'max-classes-per-file': 'off',
            // Advisory only: importing a default export under a different local name is normal here.
            'import-x/no-rename-default': 'off',
            // This is a build CLI (terminal output) and an Electron app whose skeleton deliberately
            // routes console through wrapConsoleMethod() into the logger — console is a legit channel.
            'no-console': 'off',
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/comma-dangle': 'off',
            '@stylistic/function-paren-newline': ['error', 'consistent'],
            // Restore parity with old airbnb-base brace-style (allowSingleLine was true)
            '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
            // Old airbnb-base had max-statements-per-line: "off"
            '@stylistic/max-statements-per-line': 'off',

            // ESM project: imports use .js extensions, disable "never" rule
            'import-x/extensions': 'off',
            // ESM has no directory imports: an explicit '/index.js' is required, not "useless".
            // This rule's autofix strips it and produces an invalid ERR_UNSUPPORTED_DIR_IMPORT path.
            'import-x/no-useless-path-segments': 'off',

            // Migrated rules from old .eslintrc
            'no-bitwise': ['error', { allow: ['~'] }],
            'no-sequences': 'off',
            'global-require': 'off',
            'prefer-promise-reject-errors': 'off',
            'import-x/no-dynamic-require': 'off',
            'import-x/no-extraneous-dependencies': ['error', {
                devDependencies: [
                    '**/*.test.js',
                    '**/scaffold/**/*.test.js',
                    '**/integration/**/*.js',
                    '**/helpers/**/*.js',
                    '**/skeleton/**/*.js',
                ],
            }],
        },
    },
];
