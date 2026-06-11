/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { Diagnostics, ESLint } from '../eslint';
import { Validate } from '../shared/settings';

void describe('ESLint diagnostics', () => {
	void it('marks no-unused-vars diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unused\' is defined but never used.',
			ruleId: 'no-unused-vars'
		}), true);
	});

	void it('marks plugin unused diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unusedImport\' is defined but never used.',
			ruleId: '@typescript-eslint/no-unused-vars'
		}), true);
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unusedImport\' is defined but never used.',
			ruleId: 'unused-imports/no-unused-imports'
		}), true);
	});

	void it('does not mark unrelated diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: 'Unexpected console statement.',
			ruleId: 'no-console'
		}), false);
	});

	void it('marks message-only unused diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'answer\' is assigned a value but never used.',
			ruleId: undefined
		}), true);
	});
});

void describe('ESLint settings', () => {
	void it('uses default settings when the client returns null configuration', async () => {
		let configurationRequested = false;
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const answer = 42;\n');

		ESLint.clearSettings();
		ESLint.initialize({
			workspace: {
				getConfiguration: async () => {
					configurationRequested = true;
					return null;
				}
			}
		} as any, {} as any, () => undefined, () => undefined);

		const settings = await ESLint.resolveSettings(document);

		assert.strictEqual(configurationRequested, true);
		assert.strictEqual(settings.validate, Validate.off);
		assert.strictEqual(settings.packageManager, 'npm');
		assert.strictEqual(settings.workingDirectory, undefined);
	});
});
