/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { ExtensionContext } from 'vscode';

function activateExtension(state: string) {
	const calls: string[] = [];
	const commands = new Map<string, () => Promise<void>>();
	const disposable = { dispose: () => undefined };
	const client = {
		state,
		start: async () => { calls.push('start'); },
		restart: async () => { calls.push('restart'); },
		dispose: async () => { calls.push('dispose'); },
		info: (message: string) => { calls.push(message); },
		error: () => { assert.fail('Unexpected client error'); }
	};
	const modules: Record<string, unknown> = {
		vscode: {
			workspace: {
				textDocuments: [{}],
				onDidOpenTextDocument: () => disposable,
				onDidChangeConfiguration: () => disposable,
				onDidChangeWorkspaceFolders: () => disposable
			},
			commands: {
				registerCommand: (name: string, handler: () => Promise<void>) => {
					commands.set(name, handler);
					return disposable;
				}
			}
		},
		'vscode-languageclient/node': {
			State: { Stopped: 'stopped', StartFailed: 'failed' }
		},
		'./shared/settings': { Validate: { off: 'off' } },
		'./node-utils': {},
		'./vscode-utils': {},
		'./tasks': { TaskProvider: class { start() {} } },
		'./validator': { Validator: class { check() { return 'on'; } } },
		'./client': {
			ESLintClient: {
				create: () => {
					calls.push('create');
					return [client, () => undefined, { dispose: () => { calls.push('dispose registrations'); } }];
				}
			}
		}
	};
	const exports = {} as { activate(context: ExtensionContext): void };
	runInNewContext(readFileSync(require.resolve('../extension'), 'utf8'), {
		exports,
		require: (id: string) => modules[id] ?? require(id)
	});
	exports.activate({ subscriptions: [] } as unknown as ExtensionContext);
	calls.length = 0;
	return { calls, restart: commands.get('eslint.restart')! };
}

void describe('Restart ESLint Server', () => {
	void it('starts the client when the server is stopped', async () => {
		const { calls, restart } = activateExtension('stopped');
		await restart();
		assert.deepStrictEqual(calls, ['start', 'ESLint server restarted.']);
	});

	void it('disposes client registrations before recreating a failed client', async () => {
		const { calls, restart } = activateExtension('failed');
		await restart();
		assert.deepStrictEqual(calls, ['dispose', 'dispose registrations', 'create', 'start', 'ESLint server restarted.']);
	});

	void it('restarts an existing running server', async () => {
		const { calls, restart } = activateExtension('running');
		await restart();
		assert.deepStrictEqual(calls, ['restart', 'ESLint server restarted.']);
	});
});
