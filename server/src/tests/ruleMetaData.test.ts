/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ESLint as ESLintAPI, type Rule } from 'eslint';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { CodeActions, ESLint, type ESLintModule, RuleMetaData } from '../eslint';

type CapturedESLint = Parameters<typeof RuleMetaData.capture>[0];
type Reports = Parameters<typeof RuleMetaData.capture>[1];

const ruleId = 'test/prefer-let';
const documentUri = 'untitled:rule-metadata.js';
const reports: Reports = [{ filePath: 'rule-metadata.js', errorCount: 0, warningCount: 0, messages: [] }];

function createESLint(metadata: Record<string, RuleMetaData>, isCLIEngine: boolean): CapturedESLint {
	return {
		isCLIEngine,
		lintText: async () => [],
		isPathIgnored: async () => false,
		calculateConfigForFile: async () => undefined,
		getRulesMetaForResults: () => metadata
	};
}

function createRule(type: 'problem' | 'suggestion' | 'layout'): Rule.RuleModule {
	return {
		meta: { type, fixable: 'code', schema: [] },
		create(context) {
			return {
				Program(node) {
					context.report({
						node,
						message: 'Use let instead of var.',
						fix: fixer => fixer.replaceTextRange([0, 3], 'let')
					});
				}
			};
		}
	};
}

void describe('ESLint rule metadata', () => {
	beforeEach(() => {
		RuleMetaData.clear();
		ESLint.clearSettings();
		CodeActions.remove(documentUri);
	});
	afterEach(() => {
		RuleMetaData.clear();
		ESLint.clearSettings();
		CodeActions.remove(documentUri);
	});

	for (const isCLIEngine of [false, true]) {
		for (const type of ['problem', 'suggestion', 'layout']) {
			void it(`captures ${type} metadata without docs for ${isCLIEngine ? 'CLIEngine' : 'ESLint'}`, () => {
				RuleMetaData.capture(createESLint({ [ruleId]: { type } }, isCLIEngine), reports);
				assert.strictEqual(RuleMetaData.getType(ruleId), type);
				assert.strictEqual(RuleMetaData.hasRuleId(ruleId), true);
				assert.strictEqual(RuleMetaData.getUrl(ruleId), undefined);
			});
		}
	}

	for (const url of [undefined, null, 42, false]) {
		void it(`keeps metadata but does not expose the invalid URL ${String(url)}`, () => {
			const meta: RuleMetaData = { type: 'problem', docs: { url: url as unknown as string } };
			RuleMetaData.capture(createESLint({ [ruleId]: meta }, false), reports);
			assert.strictEqual(RuleMetaData.getType(ruleId), 'problem');
			assert.strictEqual(RuleMetaData.getUrl(ruleId), undefined);
		});
	}

	void it('preserves a valid documentation URL', () => {
		const url = 'https://example.com/rules/prefer-let';
		RuleMetaData.capture(createESLint({ [ruleId]: { type: 'problem', docs: { url } } }, false), reports);
		assert.strictEqual(RuleMetaData.getType(ruleId), 'problem');
		assert.strictEqual(RuleMetaData.getUrl(ruleId), url);
	});

	void it('clears captured metadata and restores the unused-directive metadata', () => {
		RuleMetaData.capture(createESLint({ [ruleId]: { type: 'problem' } }, false), reports);
		RuleMetaData.clear();
		assert.strictEqual(RuleMetaData.hasRuleId(ruleId), false);
		assert.strictEqual(RuleMetaData.getType(RuleMetaData.unusedDisableDirectiveId), 'directive');
		assert.ok(RuleMetaData.getUrl(RuleMetaData.unusedDisableDirectiveId));
	});

	for (const type of ['problem', 'suggestion', 'layout'] as const) {
		for (const matching of [true, false]) {
			void it(`${matching ? 'keeps' : 'filters out'} ${type} fixes without docs using fixTypes`, async () => {
				const document = TextDocument.create(documentUri, 'javascript', 1, 'var answer = 42;');
				ESLint.initialize({ workspace: { getConfiguration: async () => null } } as any, {} as any, () => undefined, () => undefined);
				const settings = await ESLint.resolveSettings(document);
				const fixType = matching ? type : type === 'problem' ? 'suggestion' : 'problem';
				const options = {
					fixTypes: [fixType],
					overrideConfigFile: true,
					overrideConfig: [{
						plugins: { test: { rules: { 'prefer-let': createRule(type) } } },
						rules: { [ruleId]: 'error' }
					}]
				} satisfies ESLintAPI.Options;
				const diagnostics = await ESLint.validate(document, {
					...settings,
					options,
					library: { ESLint: ESLintAPI, CLIEngine: undefined } as unknown as ESLintModule
				});
				assert.strictEqual(diagnostics.length, 1);
				assert.strictEqual(diagnostics[0].code, ruleId);
				assert.strictEqual(diagnostics[0].codeDescription, undefined);
				const actions = [...(CodeActions.get(documentUri)?.values() ?? [])];
				assert.strictEqual(actions.length, matching ? 1 : 0);
				if (matching) {
					assert.deepStrictEqual(actions[0].edit, { range: [0, 3], text: 'let' });
				}
			});
		}
	}
});
