/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import type { LogOutputChannel } from 'vscode';
import type { StdioOptions } from 'vscode-languageclient/node';

import { createEslintStdioOptions, isEslintDebugLogMessage, sanitizeLogMessage } from '../logOutput';

type TestOutputChannel = LogOutputChannel & {
	log(message: string): void;
};

void describe('Log output', () => {
	void it('strips leading dates and ANSI sequences from log messages', () => {
		assert.strictEqual(sanitizeLogMessage('2025-08-16T13:48:56.483Z eslint:config-loader Loading config file'), 'eslint:config-loader Loading config file');
		assert.strictEqual(sanitizeLogMessage('2025-08-16 19:18:56.483 eslint:config-loader Loading config file'), 'eslint:config-loader Loading config file');
		assert.strictEqual(sanitizeLogMessage('\u001b[36;1meslint:config-loader \u001b[0mLoading config file'), 'eslint:config-loader Loading config file');
	});

	void it('detects ESLint debug log messages', () => {
		assert.strictEqual(isEslintDebugLogMessage('2025-08-16T13:48:56.483Z eslint:config-loader Loading config file'), true);
		assert.strictEqual(isEslintDebugLogMessage('eslintrc:config-array-factory Loading config file'), true);
		assert.strictEqual(isEslintDebugLogMessage('2025-08-16T13:48:56.483Z Uncaught exception received.'), false);
	});

	void it('routes ESLint debug stderr lines to info', async () => {
		const calls: string[] = [];
		const outputChannel = createOutputChannel(calls);

		await pipeOutput(createEslintStdioOptions().stderr, outputChannel, [
			'2025-08-16T13:48:56.483Z eslint:config-loader Loading config file',
			'2025-08-16T13:48:56.483Z Uncaught exception received.'
		].join('\n'));

		assert.deepStrictEqual(calls, [
			'info:eslint:config-loader Loading config file',
			'error:Uncaught exception received.'
		]);
	});

	void it('routes sanitized stdout lines to info', async () => {
		const calls: string[] = [];
		const outputChannel = createOutputChannel(calls);

		await pipeOutput(createEslintStdioOptions().stdout, outputChannel, [
			'2025-08-16T13:48:56.483Z Info message',
			'\u001b[36;1mPlain message\u001b[0m'
		].join('\n'));

		assert.deepStrictEqual(calls, [
			'info:Info message',
			'info:Plain message'
		]);
	});
});

function pipeOutput(handler: Required<StdioOptions>['stdout'], outputChannel: LogOutputChannel, content: string): Promise<void> {
	const input = new PassThrough();
	handler(input, outputChannel);
	input.end(content);
	return new Promise((resolve) => setImmediate(resolve));
}

function createOutputChannel(calls: string[]): TestOutputChannel {
	return {
		name: 'ESLint',
		append: (value: string) => calls.push(`append:${value}`),
		appendLine: (value: string) => calls.push(`appendLine:${value}`),
		replace: (value: string) => calls.push(`replace:${value}`),
		clear: () => calls.push('clear'),
		show: () => calls.push('show'),
		hide: () => calls.push('hide'),
		dispose: () => calls.push('dispose'),
		logLevel: 2,
		onDidChangeLogLevel: () => ({ dispose: () => undefined }),
		trace: (message: string) => calls.push(`trace:${message}`),
		debug: (message: string) => calls.push(`debug:${message}`),
		info: (message: string) => calls.push(`info:${message}`),
		warn: (message: string) => calls.push(`warn:${message}`),
		error: (error: string | Error) => calls.push(`error:${error instanceof Error ? error.message : error}`),
		log: (message: string) => calls.push(`log:${message}`)
	} as TestOutputChannel;
}
