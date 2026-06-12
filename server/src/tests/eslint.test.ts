/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { Diagnostics, DirectiveComments, ESLint } from '../eslint';
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

void describe('Directive comment parsing', () => {
	void it('parses a single rule in an eslint-disable-next-line directive', () => {
		const line = '  // eslint-disable-next-line no-console';
		const directive = DirectiveComments.parse(line);
		assert.ok(directive !== undefined);
		assert.strictEqual(directive!.keyword, 'eslint-disable-next-line');
		assert.deepStrictEqual(directive!.rules.map(r => r.ruleId), ['no-console']);
		const rule = directive!.rules[0];
		assert.strictEqual(line.substring(rule.start, rule.end), 'no-console');
	});

	void it('parses scoped plugin rule ids and ignores the description', () => {
		const line = '// eslint-disable-next-line security/detect-non-literal-fs-filename -- This is harmless.';
		const directive = DirectiveComments.parse(line);
		assert.ok(directive !== undefined);
		assert.deepStrictEqual(directive!.rules.map(r => r.ruleId), ['security/detect-non-literal-fs-filename']);
		const rule = directive!.rules[0];
		assert.strictEqual(line.substring(rule.start, rule.end), 'security/detect-non-literal-fs-filename');
	});

	void it('parses multiple comma separated rules', () => {
		const line = '// eslint-disable-line no-alert, @typescript-eslint/no-explicit-any';
		const directive = DirectiveComments.parse(line);
		assert.ok(directive !== undefined);
		assert.strictEqual(directive!.keyword, 'eslint-disable-line');
		assert.deepStrictEqual(directive!.rules.map(r => r.ruleId), ['no-alert', '@typescript-eslint/no-explicit-any']);
	});

	void it('does not include block comment terminators in the rule id', () => {
		const line = '/* eslint-disable no-alert, no-console */';
		const directive = DirectiveComments.parse(line);
		assert.ok(directive !== undefined);
		assert.deepStrictEqual(directive!.rules.map(r => r.ruleId), ['no-alert', 'no-console']);
		const last = directive!.rules[directive!.rules.length - 1];
		assert.strictEqual(line.substring(last.start, last.end), 'no-console');
	});

	void it('parses directives without a rule list', () => {
		const directive = DirectiveComments.parse('/* eslint-disable */');
		assert.ok(directive !== undefined);
		assert.strictEqual(directive!.keyword, 'eslint-disable');
		assert.deepStrictEqual(directive!.rules, []);
	});

	void it('returns undefined when no directive is present', () => {
		assert.strictEqual(DirectiveComments.parse('const answer = 42;'), undefined);
	});

	void it('finds the rule located at a given character offset', () => {
		const line = '// eslint-disable-line no-alert, no-console';
		const directive = DirectiveComments.parse(line)!;
		const noConsole = directive.rules[1];
		const found = DirectiveComments.findRuleAt(directive, noConsole.start + 1);
		assert.ok(found !== undefined);
		assert.strictEqual(found!.ruleId, 'no-console');
		assert.strictEqual(DirectiveComments.findRuleAt(directive, directive.keywordStart + 1), undefined);
	});

	void it('reports whether a character offset is within the directive', () => {
		const line = '// eslint-disable-next-line no-console';
		const directive = DirectiveComments.parse(line)!;
		assert.strictEqual(DirectiveComments.contains(directive, directive.keywordStart), true);
		assert.strictEqual(DirectiveComments.contains(directive, directive.rules[0].end), true);
		assert.strictEqual(DirectiveComments.contains(directive, 0), false);
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
