/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import { workspace, window, commands, Disposable, ExtensionContext, Command } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, RequestType, TransportKind, TextDocumentIdentifier, TextEdit, Protocol2Code } from 'vscode-languageclient';
import { SettingSubscriber } from './SettingSubscriber/SettingSubscriber';


interface AllFixesParams {
	textDocument: TextDocumentIdentifier;
}

interface AllFixesResult {
	documentVersion: number,
	edits: TextEdit[]
}

namespace AllFixesRequest {
	export const type: RequestType<AllFixesParams, AllFixesResult, void> = { get method() { return 'textDocument/eslint/allFixes'; } };
}

export function activate(context: ExtensionContext) {
	let eslintConfig = workspace.getConfiguration('eslint');
	// We need to go one level up since an extension compile the js code into
	// the output folder.
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions}
	};
	let settingSubscriber = new SettingSubscriber('eslint')
	const languageSettingsMap = [
		{
			name: 'enableFlow',
			value: ['flow']
		},
		{
			name: 'enableHtml',
			value: ['html']
		},
		{
			name: 'enableJavaScript',
			value: ['javascript', 'javascriptreact']
		},
		{
			name: 'enableTypeScript',
			value: ['typescript', 'typescriptreact']
		}
	];

	const getSupportedDocuments = (): string[] => {
		const eslintConfig = workspace.getConfiguration('eslint');

		return languageSettingsMap.reduce(( documentsArray, { name, value }) => {
			if (eslintConfig.get(name)) {
				return documentsArray.concat(value);
			} else {
				return documentsArray;
			}
		}, []);
	};

	let clientOptions: LanguageClientOptions = {
		documentSelector: getSupportedDocuments(),
		synchronize: {
			configurationSection: 'eslint',
			fileEvents: [
				workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}'),
				workspace.createFileSystemWatcher('**/package.json')
			]
		}
	};

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

	function fixAllProblems() {
		let textEditor = window.activeTextEditor;
		if (!textEditor) {
			return;
		}
		let uri: string = textEditor.document.uri.toString();
		client.sendRequest(AllFixesRequest.type, { textDocument: { uri }}).then((result) => {
			if (result) {
				applyTextEdits(uri, result.documentVersion, result.edits);
			}
		}, (error) => {
			window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
		});
	}

	const createNewClient = () => {
		clientOptions.documentSelector = getSupportedDocuments();
		client = new LanguageClient('ESLint', serverOptions, clientOptions);
		context.subscriptions.splice(0, 1, client.start());
	};

	const documentSettingChangeHandler = (changedSettings) => {
		// If the plugin is being disabled/enabled, settingChangeHandler can handle all changes.
		if (changedSettings.hasOwnProperty('enable')) return;

		context.subscriptions[0].dispose();
		createNewClient();
	};

	const settingChangeHandler = (changedSettings) => {
		client.notifyConfigurationChanged(changedSettings);

		if (changedSettings.enable !== undefined) {
			if (changedSettings.enable === true) {
				createNewClient();
			} else {
				context.subscriptions[0].dispose();
			}
		}
	};

	context.subscriptions.push(
		client.start(),
		settingSubscriber.subscribe(settingChangeHandler),
		settingSubscriber.subscribe(documentSettingChangeHandler, languageSettingsMap.map(({ name }) => name)),
		commands.registerCommand('eslint.applySingleFix', applyTextEdits),
		commands.registerCommand('eslint.applySameFixes', applyTextEdits),
		commands.registerCommand('eslint.applyAllFixes', applyTextEdits),
		commands.registerCommand('eslint.fixAllProblems', fixAllProblems)
	);
}
