/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import { workspace, window, commands, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, RequestType, TransportKind, TextEdit, Protocol2Code } from 'vscode-languageclient';

export function activate(context: ExtensionContext) {
	// We need to go one level up since an extension compile the js code into
	// the output folder.
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions}
	};

	let clientOptions: LanguageClientOptions = {
		documentSelector: ['javascript', 'javascriptreact'],
		synchronize: {
			configurationSection: 'eslint',
			fileEvents: workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}')
		}
	}

	let client = new LanguageClient('ESLint', serverOptions, clientOptions);

	function applyTextEdits(uri: string, documentVersion: number, edits: TextEdit[]) {
		let textEditor = window.activeTextEditor;
		if (textEditor && textEditor.document.uri.toString() === uri) {
			if (textEditor.document.version !== documentVersion) {
				window.showInformationMessage(`ESLint fixes are outdated and can't be applied to the document.`);
			}
			textEditor.edit(mutator => {
				for(let edit of edits) {
					mutator.replace(Protocol2Code.asRange(edit.range), edit.newText);
				}
			}).then((success) => {
				if (!success) {
					window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
				}
			});
		}
	}

	context.subscriptions.push(
		new SettingMonitor(client, 'eslint.enable').start(),
		commands.registerCommand('eslint.applySingleFix', applyTextEdits),
		commands.registerCommand('eslint.applySameFixes', applyTextEdits),
		commands.registerCommand('eslint.applyAllFixes', applyTextEdits)
	);
}
