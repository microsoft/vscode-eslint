/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { StatsReporter } from '../eslint';

void describe('StatsReporter.aggregate', () => {
	void it('aggregates per-rule totals across passes and sorts by time', () => {
		const result = StatsReporter.aggregate({
			fixPasses: 0,
			times: {
				passes: [
					{
						parse: { total: 12.5 },
						rules: {
							'no-unused-vars': { total: 18.42 },
							'no-console': { total: 6.1 }
						},
						fix: { total: 0.5 },
						total: 40.0
					},
					{
						parse: { total: 2.5 },
						rules: {
							'no-unused-vars': { total: 1.58 },
							'eqeqeq': { total: 3.0 }
						},
						fix: { total: 0 },
						total: 8.0
					}
				]
			}
		});
		assert.ok(result !== undefined);
		assert.strictEqual(result.parseTime, 15.0);
		assert.strictEqual(result.fixTime, 0.5);
		assert.strictEqual(result.totalTime, 48.0);
		assert.deepStrictEqual(result.rules, [
			{ ruleId: 'no-unused-vars', total: 20.0 },
			{ ruleId: 'no-console', total: 6.1 },
			{ ruleId: 'eqeqeq', total: 3.0 }
		]);
	});

	void it('returns undefined when no stats are present', () => {
		assert.strictEqual(StatsReporter.aggregate(undefined), undefined);
		assert.strictEqual(StatsReporter.aggregate({}), undefined);
		assert.strictEqual(StatsReporter.aggregate({ times: {} }), undefined);
		assert.strictEqual(StatsReporter.aggregate({ times: { passes: [] } }), undefined);
	});

	void it('ignores malformed passes and timings', () => {
		const result = StatsReporter.aggregate({
			times: {
				passes: [
					undefined as any,
					{ parse: { total: 'slow' as any }, rules: { 'no-alert': { total: NaN } }, fix: {}, total: 5 } as any
				]
			}
		});
		assert.ok(result !== undefined);
		assert.strictEqual(result.parseTime, 0);
		assert.strictEqual(result.fixTime, 0);
		assert.strictEqual(result.totalTime, 5);
		assert.deepStrictEqual(result.rules, []);
	});
});
