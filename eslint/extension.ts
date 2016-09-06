/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import { workspace, window, commands, Disposable, ExtensionContext, Command, Uri } from 'vscode';
import {
	LanguageClient, LanguageClientOptions, SettingMonitor, RequestType, TransportKind,
	TextDocumentIdentifier, TextEdit, Protocol2Code, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, ResponseError, InitializeError, ErrorCodes
} from 'vscode-languageclient';

const eslintrc: string = [
'{',
'    "env": {',
'        "browser": true,',
'        "commonjs": true,',
'        "es6": true,',
'        "node": true',
'    },',
'    "parserOptions": {',
'        "ecmaFeatures": {',
'            "jsx": true',
'        },',
'        "sourceType": "module"',
'    },',
'    "rules": {',
'        "no-const-assign": 1,',
'        "no-extra-semi": 0,',
'        "semi": 0,',
'        "no-fallthrough": 0,',
'        "no-empty": 0,',
'        "no-mixed-spaces-and-tabs": 0,',
'        "no-redeclare": 0,',
'        "no-this-before-super": 1,',
'        "no-undef": 1,',
'        "no-unreachable": 1,',
'        "no-unused-vars": 1,',
'        "no-use-before-define": 0,',
'        "constructor-super": 1,',
'        "curly": 0,',
'        "eqeqeq": 0,',
'        "func-names": 0,',
'        "valid-typeof": 1',
'    }',
'}'
].join(process.platform === 'win32' ? '\r\n' : '\n');

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

let noConfigShown: boolean = false;
interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type: RequestType<NoConfigParams, NoConfigResult, void> = { get method() { return 'eslint/noConfig'; } };
}

const exitCalled: NotificationType<[number, string]> = { method: 'eslint/exitCalled' };

export function activate(context: ExtensionContext) {
	// We need to go one level up since an extension compile the js code into
	// the output folder.
	// serverModule
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions}
	};

	let defaultErrorHandler: ErrorHandler;
	let serverCalledProcessExit: boolean = false;
	let clientOptions: LanguageClientOptions = {
		documentSelector: ['javascript', 'javascriptreact'],
		synchronize: {
			configurationSection: 'eslint',
			fileEvents: [
				workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}'),
				workspace.createFileSystemWatcher('**/package.json')
			]
		},
		initializationOptions: () => {
			let configuration = workspace.getConfiguration('eslint');
			return {
				legacyModuleResolve: configuration ? configuration.get('_legacyModuleResolve', false) : false,
				nodePath: configuration ? configuration.get('nodePath', undefined) : undefined
			};
		},
		initializationFailedHandler: (error) => {
			if (error instanceof ResponseError) {
				let responseError = (error as ResponseError<InitializeError>);
				if (responseError.code === 100) {
					if (workspace.rootPath) {
						client.warn([
							'Failed to load the ESLint library.',
							'To use ESLint in this workspace please install eslint using \'npm install eslint\' or globally using \'npm install -g eslint\'.',
							'You need to reopen the workspace after installing eslint.',
						].join('\n'));
					} else {
						client.warn([
							'Failed to load the ESLint library.',
							'To use ESLint for single JavaScript files install eslint globally using \'npm install -g eslint\'.',
							'You need to reopen VS Code after installing eslint.',
						].join('\n'));
					}
					const key = 'noESLintMessageShown';
					if (!context.globalState.get(key, false)) {
						// context.globalState.update(key, true);
						client.outputChannel.show();
					}
				} else {
					client.error('Server initialization failed.', error);
				}
			} else {
				client.error('Server initialization failed.', error);
			}
			return false;
		},
		errorHandler: {
			error: (error, message, count): ErrorAction => {
				return defaultErrorHandler.error(error, message, count);
			},
			closed: (): CloseAction => {
				if (serverCalledProcessExit) {
					return CloseAction.DoNotRestart;
				}
				return defaultErrorHandler.closed();
			}
		}
	};

	let client = new LanguageClient('ESLint', serverOptions, clientOptions);
	defaultErrorHandler = client.createDefaultErrorHandler();
	client.onNotification(exitCalled, (params) => {
		serverCalledProcessExit = true;
		client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
		window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`);
	});
	client.onRequest(NoConfigRequest.type, (params) => {
		let document = Uri.parse(params.document.uri);
		let location = document.fsPath;
		if (workspace.rootPath && document.fsPath.indexOf(workspace.rootPath) === 0) {
			location = document.fsPath.substr(workspace.rootPath.length + 1);
		}
		client.info([
			`No ESLint configuration (e.g .eslintrc) found for file: ${location}`,
			`File will not be validated. Consider running the 'Create .eslintrc.json file' command.`
		].join('\n'));
		if (!noConfigShown) {
			client.outputChannel.show();
			noConfigShown = true;
		}
		return {};
	});

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

	function runAutoFix() {
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

	function createDefaultConfiguration(): void {
		if (!workspace.rootPath) {
			window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a folder.');
		}
		let eslintConfigFile = path.join(workspace.rootPath, '.eslintrc.json');
		if (!fs.existsSync(eslintConfigFile)) {
			fs.writeFileSync(eslintConfigFile, eslintrc, { encoding: 'utf8' });
		}
	}

	context.subscriptions.push(
		new SettingMonitor(client, 'eslint.enable').start(),
		commands.registerCommand('eslint.applySingleFix', applyTextEdits),
		commands.registerCommand('eslint.applySameFixes', applyTextEdits),
		commands.registerCommand('eslint.applyAllFixes', applyTextEdits),
		commands.registerCommand('eslint.executeAutofix', runAutoFix),
		commands.registerCommand('eslint.createConfig', createDefaultConfiguration)
	);
}