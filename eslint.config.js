/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
const typescriptParser =  require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const stylistic = require('@stylistic/eslint-plugin');

module.exports = [
	{
        ignores: [
			'client/out/**/*.*',
			'server/out/**/*.*'
		]
    },
	{
		files: [
			'client/src/**/*.ts',
			'server/src/**/*.ts'
		],
		ignores: [
			'eslint.config.js',
			'playgrounds/**/*.ts'
		],
	    plugins: {
        	'@typescript-eslint': typescriptPlugin,
			'@stylistic': stylistic
		},
		languageOptions: {
			sourceType: 'module',
			parser: typescriptParser,
			parserOptions: {
				ecmaVersion: 2020
			}
		},

		rules: {
			'semi': 'off',
			'@stylistic/semi': 'error',
			'@stylistic/member-delimiter-style': ['error' ,{
				'multiline': {
				'delimiter': 'semi',
				'requireLast': true
				},
				'singleline': {
				'delimiter': 'semi',
				'requireLast': false
				},
				'multilineDetection': 'brackets'
			}],
			'indent': 'off',
			'@stylistic/indent': ['warn', 'tab', { 'SwitchCase': 1 } ],
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/consistent-type-exports': 'error',
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					'selector': 'class',
					'format': [
						'PascalCase'
					],
					'leadingUnderscore': 'allow'
				}
			],
			'no-extra-semi': 'warn',
			'curly': 'warn',
			'quotes': ['error', 'single', { 'allowTemplateLiterals': true } ],
			'eqeqeq': 'error',
			'constructor-super': 'warn',
			'prefer-const': [
				'warn',
				{
					'destructuring': 'all'
				}
			],
			'no-buffer-constructor': 'warn',
			'no-caller': 'warn',
			'no-case-declarations': 'warn',
			'no-debugger': 'warn',
			'no-duplicate-case': 'warn',
			'no-duplicate-imports': 'warn',
			'no-eval': 'warn',
			'no-async-promise-executor': 'warn',
			'no-new-wrappers': 'warn',
			'no-redeclare': 'off',
			'no-sparse-arrays': 'warn',
			'no-throw-literal': 'warn',
			'no-unsafe-finally': 'warn',
			'no-unused-labels': 'warn',
			'no-restricted-globals': [
				'warn',
				'name',
				'length',
				'event',
				'closed',
				'external',
				'status',
				'origin',
				'orientation',
				'context'
			],
			'no-var': 'warn'
		}
	},
	{
		files: [
			'client/src/**/*.ts',
		],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json']
			}
		}

	},
	{
		files: [
			'server/src/**/*.ts',
		],
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json']
			}
		},
		rules: {
			'no-console': 'error'
		}
	}
];