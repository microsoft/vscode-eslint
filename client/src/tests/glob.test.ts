/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as assert from 'assert';
import { convert2RegExp } from '../utils';

function isDefined<T>(value: T | undefined | null): asserts value is Exclude<T, undefined | null> {
	if (value === undefined || value === null) {
		throw new Error(`Value is null or undefined`);
	}
}

function toOSPath(path: string): string {
	if (process.platform !== 'win32') {
		return path;
	}
	return path.replace(/\//g, '\\');
}

suite('Glob', () => {
	test('Simple', () => {
		let regExp = convert2RegExp('/test/*/');
		isDefined(regExp);
		let matches = regExp.exec(toOSPath('/test/foo/bar/file.txt'));
		isDefined(matches);
		assert.strictEqual(matches.length, 1);
		assert.strictEqual(matches[0], toOSPath('/test/foo/'));
	});
});