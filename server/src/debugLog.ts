/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

interface DebugLogConnection {
	console: {
		info(message: string): void;
	};
}

let eslintDebugLogBridgeInstalled = false;

export function installEslintDebugLogBridge(connection: DebugLogConnection): void {
	if (eslintDebugLogBridgeInstalled || !hasEslintDebugNamespace(process.env.DEBUG)) {
		return;
	}
	eslintDebugLogBridgeInstalled = true;

	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void): boolean => {
		const output = getOutput(chunk, encodingOrCallback);
		if (output !== undefined && isEslintDebugOutput(output)) {
			const trimmedOutput = output.trimEnd();
			for (const line of trimmedOutput.length === 0 ? [] : trimmedOutput.split(/\r?\n/g)) {
				connection.console.info(line);
			}
			if (typeof encodingOrCallback === 'function') {
				encodingOrCallback();
			}
			callback?.();
			return true;
		}
		return originalWrite(chunk as any, encodingOrCallback as any, callback as any);
	}) as typeof process.stderr.write;
}

export function hasEslintDebugNamespace(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	return value.split(/[\s,]+/g).some(namespace => {
		return namespace === 'eslint:*' || namespace.startsWith('eslint:') ||
			namespace === 'eslintrc:*' || namespace.startsWith('eslintrc:');
	});
}

export function isEslintDebugOutput(value: string): boolean {
	const normalized = stripAnsi(value).trimStart();
	return /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+)?(?:eslint|eslintrc):/.test(normalized);
}

function getOutput(chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void)): string | undefined {
	if (typeof chunk === 'string') {
		return chunk;
	}
	if (chunk instanceof Uint8Array) {
		const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
		return Buffer.from(chunk).toString(encoding);
	}
	return undefined;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
