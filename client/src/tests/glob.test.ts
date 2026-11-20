/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { convert2RegExp } from '../node-utils';

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

void describe('Glob', () => {
	void it('Simple', () => {
		const regExp = convert2RegExp('/test/*/');
		isDefined(regExp);
		const matches = regExp.exec(toOSPath('/test/foo/bar/file.txt'));
		isDefined(matches);
		assert.strictEqual(matches.length, 1);
		assert.strictEqual(matches[0], toOSPath('/test/foo/'));
	});

	void it('Text before wildcard', () => {
		for (const pattern of ['/test/lib-*/', '/test/lib-?/', '/test/lib-[a-z]/']) {
			const regExp = convert2RegExp(pattern);
			isDefined(regExp);
			assert.strictEqual(regExp.test(toOSPath('/test/app/file.txt')), false, pattern);
			assert.strictEqual(regExp.exec(toOSPath('/test/lib-a/file.txt'))?.[0], toOSPath('/test/lib-a/'), pattern);
		}
	});

	void it('Text before wildcard in braces', () => {
		const regExp = convert2RegExp('/test/{lib-*,app}/');
		isDefined(regExp);
		assert.strictEqual(regExp.test(toOSPath('/test/other/file.txt')), false);
		assert.strictEqual(regExp.exec(toOSPath('/test/lib-a/file.txt'))?.[0], toOSPath('/test/lib-a/'));
		assert.strictEqual(regExp.exec(toOSPath('/test/app/file.txt'))?.[0], toOSPath('/test/app/'));
	});
});