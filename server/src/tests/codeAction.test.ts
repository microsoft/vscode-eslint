/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { CodeActionKind } from 'vscode-languageserver/node';

import { ESLintSourceFixAll, getCodeActionKindFilter } from '../codeAction';

void describe('Code action kind filter', () => {
	void it('defaults to quick fixes when no only kinds are provided', () => {
		const filter = getCodeActionKindFilter(undefined);

		assert.strictEqual(filter.kind, CodeActionKind.QuickFix);
		assert.strictEqual(filter.quickFix, true);
		assert.strictEqual(filter.source, false);
		assert.strictEqual(filter.sourceFixAll, false);
	});

	void it('honors source fix all when it is not the first only kind', () => {
		const filter = getCodeActionKindFilter(['source.organizeImports', ESLintSourceFixAll]);

		assert.strictEqual(filter.quickFix, false);
		assert.strictEqual(filter.source, false);
		assert.strictEqual(filter.sourceFixAll, true);
	});

	void it('rejects unrelated source only kinds', () => {
		const filter = getCodeActionKindFilter(['source.organizeImports']);

		assert.strictEqual(filter.quickFix, false);
		assert.strictEqual(filter.source, false);
		assert.strictEqual(filter.sourceFixAll, false);
	});

	void it('uses quick fix kind when quick fix is one of multiple only kinds', () => {
		const filter = getCodeActionKindFilter(['source.organizeImports', CodeActionKind.QuickFix]);

		assert.strictEqual(filter.kind, CodeActionKind.QuickFix);
		assert.strictEqual(filter.quickFix, true);
		assert.strictEqual(filter.source, false);
		assert.strictEqual(filter.sourceFixAll, false);
	});
});
