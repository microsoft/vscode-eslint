/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { Diagnostics, ESLint, FixableProblem } from '../eslint';
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

void describe('FixableProblem.getLineEnding', () => {
	function createFixableProblem(document: TextDocument, fix: { range: [number, number]; text: string }): FixableProblem {
		return {
			label: 'Fix this linebreak-style problem',
			documentVersion: document.version,
			ruleId: 'linebreak-style',
			line: 1,
			diagnostic: {
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				message: `Expected linebreaks to be 'LF' but found 'CRLF'.`
			},
			edit: fix
		};
	}

	void it('detects a CRLF to LF line ending fix', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\r\nconst b = 2;\r\n');
		// The fix ESLint reports for `linebreak-style: unix` on a CRLF file.
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 14], text: '\n' })), 'LF');
	});

	void it('detects a LF to CRLF line ending fix', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\nconst b = 2;\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 13], text: '\r\n' })), 'CRLF');
	});

	void it('detects a fix spanning several line breaks', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\r\n\r\nconst b = 2;\r\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 16], text: '\n\n' })), 'LF');
	});

	void it('ignores a fix that changes the number of line breaks', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\n\nconst b = 2;\n');
		// Removing a blank line is not a line ending conversion.
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 14], text: '\n' })), undefined);
	});

	void it('rejects a long run of line breaks followed by other text', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;' + '\r\n'.repeat(24) + ' const b = 2;');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 61], text: '\n' })), undefined);
	});

	void it('detects a lone carriage return line ending fix', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\rconst b = 2;\r');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 13], text: '\n' })), 'LF');
	});

	void it('ignores a fix that does not change the line ending', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\r\nconst b = 2;\r\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 14], text: '\r\n' })), undefined);
	});

	void it('ignores a fix that removes code', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;;\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [11, 12], text: '' })), undefined);
	});

	void it('ignores a fix that deletes a line break', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\r\nconst b = 2;\r\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 14], text: '' })), undefined);
	});

	void it('ignores a fix that inserts a line break', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\nconst b = 2;\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [12, 12], text: '\n' })), undefined);
	});

	void it('ignores a fix that covers code and a line break', () => {
		const document = TextDocument.create('file:///workspace/test.js', 'javascript', 1, 'const a = 1;\r\n');
		assert.strictEqual(FixableProblem.getLineEnding(document, createFixableProblem(document, { range: [11, 14], text: '\n' })), undefined);
	});
});
