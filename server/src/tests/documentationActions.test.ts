/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { it } from 'node:test';
import {
	CodeAction, CodeActionRequest, ConfigurationRequest, createProtocolConnection,
	DidOpenTextDocumentNotification, DocumentDiagnosticReportKind, DocumentDiagnosticRequest,
	InitializedNotification, InitializeRequest, Range
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

void it('offers documentation only for rules with a nonempty URL', { timeout: 20_000 }, async (context) => {
	const root = path.resolve(__dirname, '../../..');
	const fixture = path.join(root, 'server/src/tests/fixtures/ruleMetadata/rules.cjs');
	const uri = URI.file(path.join(path.dirname(fixture), 'test.js')).toString();
	const child = spawn(process.execPath, [path.resolve(__dirname, '../eslintServer.js'), '--stdio'], { cwd: root, stdio: 'pipe' });
	const connection = createProtocolConnection(child.stdout, child.stdin);
	const messages: string[] = [];
	child.stderr.on('data', (data: Buffer) => messages.push(data.toString()));
	child.once('exit', () => connection.dispose());
	context.after(async () => {
		connection.dispose();
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill();
			await exited;
		}
	});
	connection.onNotification('window/logMessage', (params: { message: string }) => { messages.push(params.message); });
	connection.onRequest(ConfigurationRequest.type, params => params.items.map(() => ({
		validate: 'on',
		workingDirectory: { directory: root, '!cwd': true },
		options: { overrideConfigFile: fixture, fixTypes: ['problem'] },
		codeAction: {
			disableRuleComment: { enable: false, location: 'separateLine', commentStyle: 'line' },
			showDocumentation: { enable: true }
		}
	})));
	connection.listen();
	await connection.sendRequest(InitializeRequest.type, {
		processId: process.pid,
		rootUri: URI.file(root).toString(),
		capabilities: {
			workspace: { configuration: true },
			textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } } }
		}
	});
	await connection.sendNotification(InitializedNotification.type, {});
	await connection.sendNotification(DidOpenTextDocumentNotification.type, {
		textDocument: { uri, languageId: 'javascript', version: 1, text: 'var answer = 42;' }
	});
	const report = await connection.sendRequest(DocumentDiagnosticRequest.type, { textDocument: { uri } });
	assert.strictEqual(report.kind, DocumentDiagnosticReportKind.Full);
	if (report.kind !== DocumentDiagnosticReportKind.Full) {
		assert.fail('Expected a full diagnostic report');
	}
	assert.strictEqual(report.items.length, 4, messages.join('\n'));
	const actions = await connection.sendRequest(CodeActionRequest.type, {
		textDocument: { uri },
		range: Range.create(0, 0, 0, 16),
		context: { diagnostics: report.items, only: ['quickfix'] }
	});
	assert.ok(actions);
	const codeActions = actions.filter(CodeAction.is);
	const documentation = codeActions.filter(action => action.command?.command === 'eslint.openRuleDoc');
	assert.deepStrictEqual(documentation.map(action => action.title), ['Show documentation for test/valid']);
	const fixes = codeActions.filter(action => action.command?.command === 'eslint.applySingleFix');
	assert.strictEqual(fixes.length, 4, 'URL-less rules must still offer their matching fixes');
});
