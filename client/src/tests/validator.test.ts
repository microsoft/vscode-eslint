/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import type { TextDocument, Uri } from 'vscode';

import { Validate } from '../shared/settings';
import { Validator, ValidatorWorkspace } from '../validator';

function createDocument(scheme: string, value: string): TextDocument {
	return {
		languageId: 'javascript',
		uri: {
			scheme,
			toString: () => value
		} as Uri
	} as TextDocument;
}

function createValidator(settings: Record<string, unknown>, workspaceFolderCount: number, isInWorkspace: boolean): Validator {
	const workspace: ValidatorWorkspace = {
		workspaceFolders: Array.from({ length: workspaceFolderCount }),
		getConfiguration: () => ({
			get: <T>(section: string, defaultValue: T): T => (settings[section] ?? defaultValue) as T
		}),
		getWorkspaceFolder: () => isInWorkspace ? {} : undefined
	};
	return new Validator(workspace);
}

void describe('Validator workspace boundaries', () => {
	void it('keeps the existing behavior by default', () => {
		const validator = createValidator({ probe: ['javascript'] }, 1, false);
		assert.strictEqual(validator.check(createDocument('file', 'file:///outside.js')), Validate.probe);
	});

	void it('ignores external files when requested', () => {
		const validator = createValidator({ ignoreOutsideWorkspace: true, probe: ['javascript'] }, 1, false);
		assert.strictEqual(validator.check(createDocument('file', 'file:///outside.js')), Validate.off);
	});

	void it('takes precedence over explicit language validation', () => {
		const validator = createValidator({ ignoreOutsideWorkspace: true, validate: ['javascript'] }, 1, false);
		assert.strictEqual(validator.check(createDocument('file', 'file:///outside.js')), Validate.off);
	});

	void it('still validates files in any workspace folder', () => {
		const validator = createValidator({ ignoreOutsideWorkspace: true, probe: ['javascript'] }, 2, true);
		assert.strictEqual(validator.check(createDocument('file', 'file:///workspace/source.js')), Validate.probe);
	});

	void it('keeps single-file mode working when no folder is open', () => {
		const validator = createValidator({ ignoreOutsideWorkspace: true, probe: ['javascript'] }, 0, false);
		assert.strictEqual(validator.check(createDocument('file', 'file:///single-file.js')), Validate.probe);
	});

	void it('does not classify virtual documents as external files', () => {
		const validator = createValidator({ ignoreOutsideWorkspace: true, probe: ['javascript'] }, 1, false);
		assert.strictEqual(validator.check(createDocument('untitled', 'untitled:Untitled-1')), Validate.probe);
	});
});
