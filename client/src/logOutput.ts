/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import type { LogOutputChannel } from 'vscode';

type LoggableOutputChannel = LogOutputChannel & {
	log?: (message: string, ...args: any[]) => void;
};

const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const leadingDatePattern = /^\s*(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)?)\s+/;

export function sanitizeLogMessage(message: string): string {
	return message.replace(ansiPattern, '').replace(leadingDatePattern, '');
}

export function isEslintDebugLogMessage(message: string): boolean {
	return /^(?:eslint|eslintrc):/.test(sanitizeLogMessage(message).trimStart());
}

export function sanitizeLogOutputChannel(outputChannel: LogOutputChannel): LogOutputChannel {
	const originalError = outputChannel.error.bind(outputChannel);
	const originalWarn = outputChannel.warn.bind(outputChannel);
	const originalInfo = outputChannel.info.bind(outputChannel);

	outputChannel.error = ((error: string | Error, ...args: any[]): void => {
		if (typeof error !== 'string') {
			originalError(error, ...args);
			return;
		}
		const message = sanitizeLogMessage(error);
		if (isEslintDebugLogMessage(message)) {
			originalInfo(message, ...args);
		} else {
			originalError(message, ...args);
		}
	}) as LogOutputChannel['error'];

	outputChannel.warn = ((message: string, ...args: any[]): void => {
		originalWarn(sanitizeLogMessage(message), ...args);
	}) as LogOutputChannel['warn'];

	outputChannel.info = ((message: string, ...args: any[]): void => {
		originalInfo(sanitizeLogMessage(message), ...args);
	}) as LogOutputChannel['info'];

	const loggableOutputChannel = outputChannel as LoggableOutputChannel;
	if (typeof loggableOutputChannel.log === 'function') {
		const originalLog = loggableOutputChannel.log.bind(outputChannel);
		loggableOutputChannel.log = (message: string, ...args: any[]): void => {
			originalLog(sanitizeLogMessage(message), ...args);
		};
	}

	return outputChannel;
}
