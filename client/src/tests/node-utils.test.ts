/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findExecutableOnPath } from '../node-utils';

void describe('findExecutableOnPath', () => {
	const isWindows = process.platform === 'win32';
	const fileName = isWindows ? 'node.exe' : 'node';
	let root: string;
	let first: string;
	let second: string;
	let empty: string;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-find-executable-'));
		first = path.join(root, 'first');
		second = path.join(root, 'second');
		empty = path.join(root, 'empty');
		for (const directory of [first, second, empty]) {
			fs.mkdirSync(directory);
		}
		fs.writeFileSync(path.join(first, fileName), '', { mode: 0o755 });
		fs.writeFileSync(path.join(second, fileName), '', { mode: 0o755 });
	});

	after(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	void it('returns the first match on the PATH', () => {
		const env = { PATH: [empty, second, first].join(path.delimiter) };
		assert.strictEqual(findExecutableOnPath('node', env), path.join(second, fileName));
	});

	void it('returns undefined if not found', () => {
		assert.strictEqual(findExecutableOnPath('node', { PATH: empty }), undefined);
		assert.strictEqual(findExecutableOnPath('node', {}), undefined);
		assert.strictEqual(findExecutableOnPath('node', { PATH: '' }), undefined);
	});

	void it('ignores relative PATH entries', () => {
		const relative = path.relative(process.cwd(), first);
		assert.strictEqual(findExecutableOnPath('node', { PATH: ['.', relative].join(path.delimiter) }), undefined);
	});

	void it('ignores directories with the executable name', () => {
		fs.mkdirSync(path.join(empty, fileName));
		try {
			assert.strictEqual(findExecutableOnPath('node', { PATH: [empty, first].join(path.delimiter) }), path.join(first, fileName));
		} finally {
			fs.rmdirSync(path.join(empty, fileName));
		}
	});

	void it('ignores non executable files', { skip: isWindows }, () => {
		const nonExecutable = path.join(root, 'non-executable');
		fs.mkdirSync(nonExecutable);
		fs.writeFileSync(path.join(nonExecutable, fileName), '', { mode: 0o644 });
		assert.strictEqual(findExecutableOnPath('node', { PATH: [nonExecutable, first].join(path.delimiter) }), path.join(first, fileName));
	});

	void it('accepts quoted PATH entries on Windows', { skip: !isWindows }, () => {
		assert.strictEqual(findExecutableOnPath('node', { PATH: [`""`, `"${second}"`, first].join(path.delimiter) }), path.join(second, fileName));
	});

	void it('reads the current PATH on every call', () => {
		const removed = path.join(root, 'removed');
		fs.mkdirSync(removed);
		fs.writeFileSync(path.join(removed, fileName), '', { mode: 0o755 });
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = [removed, first].join(path.delimiter);
			assert.strictEqual(findExecutableOnPath('node'), path.join(removed, fileName));
			fs.rmSync(path.join(removed, fileName));
			assert.strictEqual(findExecutableOnPath('node'), path.join(first, fileName));
			process.env.PATH = second;
			assert.strictEqual(findExecutableOnPath('node'), path.join(second, fileName));
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});
});
