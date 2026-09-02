/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as readline from 'readline';
import type { Readable } from 'stream';

import type { StdioOptions } from 'vscode-languageclient/node';

const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const leadingDatePattern = /^\s*(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)?)\s+/;

export function sanitizeLogMessage(message: string): string {
	return message.replace(ansiPattern, '').replace(leadingDatePattern, '');
}

export function isEslintDebugLogMessage(message: string): boolean {
	return /^(?:eslint|eslintrc):/.test(sanitizeLogMessage(message).trimStart());
}

export function createEslintStdioOptions(): Required<StdioOptions> {
	return {
		stdout: (input, outputChannel) => {
			pipeLines(input, line => outputChannel.info(sanitizeLogMessage(line)));
		},
		stderr: (input, outputChannel) => {
			pipeLines(input, line => {
				const message = sanitizeLogMessage(line);
				if (isEslintDebugLogMessage(message)) {
					outputChannel.info(message);
				} else {
					outputChannel.error(message);
				}
			});
		}
	};
}

function pipeLines(input: Readable, handler: (line: string) => void): void {
	readline.createInterface({
		input,
		crlfDelay: Infinity,
		terminal: false,
		historySize: 0
	}).on('line', handler);
}
