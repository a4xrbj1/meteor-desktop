import { configs, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import globals from 'globals';

const FILES = [
    'lib/**/*.js',
    'plugins/**/*.js',
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
            'plugins/bundler/version._desktop_.js',
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
                'meteor-desktop-test-suite',
            ],
        },
        rules: {
            // Style overrides
            '@stylistic/max-len': ['error', { code: 120 }],
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/comma-dangle': 'off',
            '@stylistic/function-paren-newline': ['error', 'consistent'],
            // Restore parity with old airbnb-base brace-style (allowSingleLine was true)
            '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
            // Old airbnb-base had max-statements-per-line: "off"
            '@stylistic/max-statements-per-line': 'off',

            // ESM project: imports use .js extensions, disable "never" rule
            'import-x/extensions': 'off',

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
