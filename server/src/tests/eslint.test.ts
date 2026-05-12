/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';

import { Diagnostics } from '../eslint';

suite('ESLint diagnostics', () => {
	test('marks no-unused-vars diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unused\' is defined but never used.',
			ruleId: 'no-unused-vars'
		}), true);
	});

	test('marks plugin unused diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unusedImport\' is defined but never used.',
			ruleId: '@typescript-eslint/no-unused-vars'
		}), true);
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'unusedImport\' is defined but never used.',
			ruleId: 'unused-imports/no-unused-imports'
		}), true);
	});

	test('does not mark unrelated diagnostics as unnecessary', () => {
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: '\'answer\' is assigned a value but never used.',
			ruleId: 'no-console'
		}), true);
		assert.strictEqual(Diagnostics.isUnnecessary({
			message: 'Unexpected console statement.',
			ruleId: 'no-console'
		}), false);
	});
});
