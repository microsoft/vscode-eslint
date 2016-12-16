/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import { workspace, window, commands, Disposable, ExtensionContext, Uri, StatusBarAlignment, TextEditor, TextDocument } from 'vscode';
import {
	LanguageClient, LanguageClientOptions, SettingMonitor, RequestType, TransportKind,
	TextDocumentIdentifier, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, State as ClientState,
	RevealOutputChannelOn, DocumentSelector, VersionedTextDocumentIdentifier, ExecuteCommandRequest, ExecuteCommandParams
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
'        "no-const-assign": "warn",',
'        "no-this-before-super": "warn",',
'        "no-undef": "warn",',
'        "no-unreachable": "warn",',
'        "no-unused-vars": "warn",',
'        "constructor-super": "warn",',
'        "valid-typeof": "warn"',
'    }',
'}'
].join(process.platform === 'win32' ? '\r\n' : '\n');

namespace Is {
	const toString = Object.prototype.toString;

	export function boolean(value: any): value is boolean {
		return value === true || value === false;
	}

	export function string(value: any): value is string {
		return toString.call(value) === '[object String]';
	}
}

interface ValidateItem {
	language: string;
	autoFix?: boolean;
}

namespace ValidateItem {
	export function is(item: any): item is ValidateItem {
		let candidate = item as ValidateItem;
		return candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0);
	}
}

interface NoESLintState {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
}

enum Status {
	ok = 1,
	warn = 2,
	error = 3
}

interface StatusParams {
	state: Status
}

namespace StatusNotification {
	export const type: NotificationType<StatusParams, void> = { get method() { return 'eslint/status'; }, _: undefined };
}

interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type: RequestType<NoConfigParams, NoConfigResult, void, void> = { get method() { return 'eslint/noConfig'; }, _: undefined };
}


interface NoESLintLibraryParams {
	source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {
}

namespace NoESLintLibraryRequest {
	export const type: RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void, void> = { get method() { return 'eslint/noLibrary'; }, _: undefined };
}

const exitCalled: NotificationType<[number, string], void> = { method: 'eslint/exitCalled', _: undefined };

function enable() {
	if (!workspace.rootPath) {
		window.showErrorMessage('ESLint can only be enabled if VS Code is opened on a workspace folder.');
		return;
	}
	workspace.getConfiguration('eslint').update('enable', true, false);
}

function disable() {
	if (!workspace.rootPath) {
		window.showErrorMessage('ESLint can only be disabled if VS Code is opened on a workspace folder.');
		return;
	}
	workspace.getConfiguration('eslint').update('enable', false, false);
}

function createDefaultConfiguration(): void {
	if (!workspace.rootPath) {
		window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.');
		return;
	}
	let eslintConfigFile = path.join(workspace.rootPath, '.eslintrc.json');
	if (!fs.existsSync(eslintConfigFile)) {
		fs.writeFileSync(eslintConfigFile, eslintrc, { encoding: 'utf8' });
	}
}

let dummyCommands: [Disposable];

export function activate(context: ExtensionContext) {
	let supportedLanguages: Set<string>;
	function configurationChanged() {
		supportedLanguages = new Set<string>();
		let settings = workspace.getConfiguration('eslint');
		if (settings) {
			let toValidate = settings.get('validate', undefined);
			if (toValidate && Array.isArray(toValidate)) {
				toValidate.forEach(item => {
					if (Is.string(item)) {
						supportedLanguages.add(item);
					} else if (ValidateItem.is(item)) {
						supportedLanguages.add(item.language);
					}
				});
			}
		}
	}
	configurationChanged();
	const configurationListener = workspace.onDidChangeConfiguration(configurationChanged);

	let activated: boolean;
	let notValidating = () => window.showInformationMessage('ESLint is not validating any files yet.');
	dummyCommands = [
		commands.registerCommand('eslint.executeAutofix', notValidating),
		commands.registerCommand('eslint.showOutputChannel', notValidating)
	];
	function didOpenTextDocument(textDocument: TextDocument) {
		if (supportedLanguages.has(textDocument.languageId)) {
			configurationListener.dispose();
			openListener.dispose();
			activated = true;
			realActivate(context);
		}
	};
	const openListener = workspace.onDidOpenTextDocument(didOpenTextDocument);
	for (let textDocument of workspace.textDocuments) {
		if (activated) {
			break;
		}
		didOpenTextDocument(textDocument);
	}

	context.subscriptions.push(
		commands.registerCommand('eslint.createConfig', createDefaultConfiguration),
		commands.registerCommand('eslint.enable', enable),
		commands.registerCommand('eslint.disable', disable)
	);
}

export function realActivate(context: ExtensionContext) {

	let statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0);
	let eslintStatus: Status = Status.ok;
	let serverRunning: boolean = false;

	statusBarItem.text = 'ESLint';
	statusBarItem.command = 'eslint.showOutputChannel';

	function showStatusBarItem(show: boolean): void {
		if (show) {
			statusBarItem.show();
		} else {
			statusBarItem.hide();
		}
	}

	function updateStatus(status: Status) {
		switch (status) {
			case Status.ok:
				statusBarItem.color = undefined;
				break;
			case Status.warn:
				statusBarItem.color = 'yellow';
				break;
			case Status.error:
				statusBarItem.color = 'darkred';
				break;
		}
		eslintStatus = status;
		udpateStatusBarVisibility(window.activeTextEditor);
	}

	function udpateStatusBarVisibility(editor: TextEditor): void {
		statusBarItem.text = eslintStatus === Status.ok ? 'ESLint' : 'ESLint!';
		showStatusBarItem(
			serverRunning &&
			(
				eslintStatus !== Status.ok ||
				(editor && (editor.document.languageId === 'javascript' || editor.document.languageId === 'javascriptreact'))
			)
		);
	}

	window.onDidChangeActiveTextEditor(udpateStatusBarVisibility);
	udpateStatusBarVisibility(window.activeTextEditor);

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	// serverModule
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6009"] };
	let serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions}
	};

	let defaultErrorHandler: ErrorHandler;
	let serverCalledProcessExit: boolean = false;
	let staticDocuments: DocumentSelector = [{ scheme: 'file', pattern: '**/package.json'}, { scheme: 'file', pattern: '**/.eslintr{c.js,c.yaml,c.yml,c,c.json'}];
	let languages = ['javascript', 'javascriptreact']
	let clientOptions: LanguageClientOptions = {
		documentSelector: staticDocuments,
		diagnosticCollectionName: 'eslint',
		revealOutputChannelOn: RevealOutputChannelOn.Never,
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
				nodePath: configuration ? configuration.get('nodePath', undefined) : undefined,
				languageIds: configuration ? configuration.get('valiadate', languages) : languages
			};
		},
		initializationFailedHandler: (error) => {
			client.error('Server initialization failed.', error);
			client.outputChannel.show(true);
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
	const running = 'ESLint server is running.';
	const stopped = 'ESLint server stopped.'
	client.onDidChangeState((event) => {
		if (event.newState === ClientState.Running) {
			client.info(running);
			statusBarItem.tooltip = running;
			serverRunning = true;
		} else {
			client.info(stopped);
			statusBarItem.tooltip = stopped;
			serverRunning = false;
		}
		udpateStatusBarVisibility(window.activeTextEditor);
	});
	client.onReady().then(() => {
		client.onNotification(StatusNotification.type, (params) => {
			updateStatus(params.state);
		});

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
			client.warn([
				'',
				`No ESLint configuration (e.g .eslintrc) found for file: ${location}`,
				`File will not be validated. Consider running the 'Create .eslintrc.json file' command.`,
				`Alternatively you can disable ESLint for this workspace by executing the 'Disable ESLint for this workspace' command.`
			].join('\n'));
			eslintStatus = Status.warn;
			udpateStatusBarVisibility(window.activeTextEditor);
			return {};
		});

		client.onRequest(NoESLintLibraryRequest.type, (params) => {
			const key = 'noESLintMessageShown';
			let state = context.globalState.get<NoESLintState>(key, {});
			let uri: Uri = Uri.parse(params.source.uri);
			if (workspace.rootPath) {
				client.info([
					'',
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					'',
					'To use ESLint in this workspace please install eslint using \'npm install eslint\' or globally using \'npm install -g eslint\'.',
					'You need to reopen the workspace after installing eslint.',
					'',
					`Alternatively you can disable ESLint for this workspace by executing the 'Disable ESLint for this workspace' command.`
				].join('\n'));
				if (!state.workspaces) {
					state.workspaces = Object.create(null);
				}
				if (!state.workspaces[workspace.rootPath]) {
					state.workspaces[workspace.rootPath] = true;
					client.outputChannel.show(true);
					context.globalState.update(key, state);
				}
			} else {
				client.info([
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					'To use ESLint for single JavaScript file install eslint globally using \'npm install -g eslint\'.',
					'You need to reopen VS Code after installing eslint.',
				].join('\n'));
				if (!state.global) {
					state.global = true;
					client.outputChannel.show(true);
					context.globalState.update(key, state);
				}
			}
			return {};
		});
	});

	if (dummyCommands) {
		dummyCommands.forEach(command => command.dispose());
		dummyCommands = undefined;
	}
	context.subscriptions.push(
		new SettingMonitor(client, 'eslint.enable').start(),
		commands.registerCommand('eslint.executeAutofix', () => {
			let textEditor = window.activeTextEditor;
			if (!textEditor) {
				return;
			}
			let textDocument: VersionedTextDocumentIdentifier = {
				uri: textEditor.document.uri.toString(),
				version: textEditor.document.version
			};
			let params: ExecuteCommandParams = {
				command: 'eslint.applyAutoFix',
				arguments: [textDocument]
			}
			client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
				window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
			});
		}),
		commands.registerCommand('eslint.showOutputChannel', () => { client.outputChannel.show(); }),
		statusBarItem
	);
}

export function deactivate() {
	if (dummyCommands) {
		dummyCommands.forEach(command => command.dispose());
	}
}