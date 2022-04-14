/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as fs from 'fs';
import {
	workspace as Workspace, window as Window, commands as Commands, languages as Languages, Disposable, ExtensionContext, Uri,
	StatusBarAlignment, TextDocument, CodeActionContext, Diagnostic, ProviderResult, Command, QuickPickItem,
	WorkspaceFolder as VWorkspaceFolder, CodeAction, MessageItem, ConfigurationTarget, env as Env, CodeActionKind,
	WorkspaceConfiguration, ThemeColor, NotebookCell
} from 'vscode';
import {
	LanguageClient, LanguageClientOptions, TransportKind, ErrorHandler, ErrorHandlerResult, CloseAction, CloseHandlerResult,
	State as ClientState, RevealOutputChannelOn, VersionedTextDocumentIdentifier, ExecuteCommandRequest, ExecuteCommandParams,
	ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, ProposedFeatures, Proposed
} from 'vscode-languageclient/node';

import { findEslint, convert2RegExp, toOSPath, toPosixPath, Semaphore, Is } from './utils';
import { TaskProvider } from './tasks';
import {
	CodeActionsOnSaveMode, CodeActionsOnSaveRules, ConfigurationSettings, DirectoryItem, ESLintSeverity, ModeItem,
	RuleCustomization, Validate
} from './shared/settings';
import {
	CodeActionsOnSave,
	LegacyDirectoryItem, Migration, PatternItem, ValidateItem
} from './settings';
import {
	ExitCalled, NoConfigRequest, NoESLintLibraryRequest, OpenESLintDocRequest, ProbeFailedRequest, ShowOutputChannel, Status,
	StatusNotification, StatusParams
} from './shared/customMessages';

interface NoESLintState {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
}

interface WorkspaceFolderItem extends QuickPickItem {
	folder: VWorkspaceFolder;
}

async function pickFolder(folders: ReadonlyArray<VWorkspaceFolder>, placeHolder: string): Promise<VWorkspaceFolder | undefined> {
	if (folders.length === 1) {
		return Promise.resolve(folders[0]);
	}

	const selected = await Window.showQuickPick(
		folders.map<WorkspaceFolderItem>((folder) => { return { label: folder.name, description: folder.uri.fsPath, folder: folder }; }),
		{ placeHolder: placeHolder }
	);
	if (selected === undefined) {
		return undefined;
	}
	return selected.folder;
}

function createDefaultConfiguration(): void {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		void Window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.');
		return;
	}
	const noConfigFolders = folders.filter(folder => {
		const configFiles = ['.eslintrc.js', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc', '.eslintrc.json'];
		for (const configFile of configFiles) {
			if (fs.existsSync(path.join(folder.uri.fsPath, configFile))) {
				return false;
			}
		}
		return true;
	});
	if (noConfigFolders.length === 0) {
		if (folders.length === 1) {
			void Window.showInformationMessage('The workspace already contains an ESLint configuration file.');
		} else {
			void Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.');
		}
		return;
	}
	void pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(async (folder) => {
		if (!folder) {
			return;
		}
		const folderRootPath = folder.uri.fsPath;
		const terminal = Window.createTerminal({
			name: `ESLint init`,
			cwd: folderRootPath
		});
		const eslintCommand = await findEslint(folderRootPath);
		terminal.sendText(`${eslintCommand} --init`);
		terminal.show();
	});
}

let onActivateCommands: Disposable[] | undefined;

const probeFailed: Set<string> = new Set();
function computeValidate(textDocument: TextDocument): Validate {
	const config = Workspace.getConfiguration('eslint', textDocument.uri);
	if (!config.get('enable', true)) {
		return Validate.off;
	}
	const languageId = textDocument.languageId;
	const validate = config.get<(ValidateItem | string)[]>('validate');
	if (Array.isArray(validate)) {
		for (const item of validate) {
			if (Is.string(item) && item === languageId) {
				return Validate.on;
			} else if (ValidateItem.is(item) && item.language === languageId) {
				return Validate.on;
			}
		}
	}
	const uri: string = textDocument.uri.toString();
	if (probeFailed.has(uri)) {
		return Validate.off;
	}
	const probe: string[] | undefined = config.get<string[]>('probe');
	if (Array.isArray(probe)) {
		for (const item of probe) {
			if (item === languageId) {
				return Validate.probe;
			}
		}
	}
	return Validate.off;
}

let taskProvider: TaskProvider;
let client: LanguageClient;

export function activate(context: ExtensionContext) {

	function didOpenTextDocument(textDocument: TextDocument) {
		if (activated) {
			return;
		}
		if (computeValidate(textDocument) !== Validate.off) {
			openListener.dispose();
			configurationListener.dispose();
			activated = true;
			realActivate(context);
		}
	}

	function configurationChanged() {
		if (activated) {
			return;
		}
		for (const textDocument of Workspace.textDocuments) {
			if (computeValidate(textDocument) !== Validate.off) {
				openListener.dispose();
				configurationListener.dispose();
				activated = true;
				realActivate(context);
				return;
			}
		}
	}

	let activated: boolean = false;
	const openListener: Disposable = Workspace.onDidOpenTextDocument(didOpenTextDocument);
	const configurationListener: Disposable = Workspace.onDidChangeConfiguration(configurationChanged);

	const notValidating = () => {
		const enabled = Workspace.getConfiguration('eslint', Window.activeTextEditor?.document).get('enable', true);
		if (!enabled) {
			void Window.showInformationMessage(`ESLint is not running because the deprecated setting 'eslint.enable' is set to false. Remove the setting and use the extension disablement feature.`);
		} else {
			void Window.showInformationMessage('ESLint is not running. By default only TypeScript and JavaScript files are validated. If you want to validate other file types please specify them in the \'eslint.probe\' setting.');
		}
	};
	onActivateCommands = [
		Commands.registerCommand('eslint.executeAutofix', notValidating),
		Commands.registerCommand('eslint.showOutputChannel', notValidating),
		Commands.registerCommand('eslint.migrateSettings', notValidating),
		Commands.registerCommand('eslint.restart', notValidating)
	];

	context.subscriptions.push(
		Commands.registerCommand('eslint.createConfig', createDefaultConfiguration)
	);
	taskProvider = new TaskProvider();
	taskProvider.start();

	configurationChanged();
}

function realActivate(context: ExtensionContext): void {

	const statusBarItem = Window.createStatusBarItem('generalStatus', StatusBarAlignment.Right, 0);
	let serverRunning: boolean | undefined;

	const starting = 'ESLint server is starting.';
	const running = 'ESLint server is running.';
	const stopped = 'ESLint server stopped.';
	statusBarItem.name = 'ESLint';
	statusBarItem.text = 'ESLint';
	statusBarItem.command = 'eslint.showOutputChannel';

	const documentStatus: Map<string, Status> = new Map();

	function updateDocumentStatus(params: StatusParams): void {
		documentStatus.set(params.uri, params.state);
		updateStatusBar(params.uri);
	}

	function updateStatusBar(uri: string | undefined) {
		const status = function() {
			if (serverRunning === false) {
				return Status.error;
			}
			if (uri === undefined) {
				uri = Window.activeTextEditor?.document.uri.toString();
			}
			return (uri !== undefined ? documentStatus.get(uri) : undefined) ?? Status.ok;
		}();
		let icon: string| undefined;
		let tooltip: string | undefined;
		let text: string = 'ESLint';
		let backgroundColor: ThemeColor | undefined;
		let foregroundColor: ThemeColor | undefined;
		switch (status) {
			case Status.ok:
				icon = undefined;
				foregroundColor = new ThemeColor('statusBarItem.foreground');
				backgroundColor = new ThemeColor('statusBarItem.background');
				break;
			case Status.warn:
				icon = '$(alert)';
				foregroundColor = new ThemeColor('statusBarItem.warningForeground');
				backgroundColor = new ThemeColor('statusBarItem.warningBackground');
				break;
			case Status.error:
				icon = '$(issue-opened)';
				foregroundColor = new ThemeColor('statusBarItem.errorForeground');
				backgroundColor = new ThemeColor('statusBarItem.errorBackground');
				break;
		}
		statusBarItem.text = icon !== undefined ? `${icon} ${text}` : text;
		statusBarItem.color = foregroundColor;
		statusBarItem.backgroundColor = backgroundColor;
		statusBarItem.tooltip = tooltip ? tooltip : serverRunning === undefined ? starting : serverRunning === true ? running : stopped;
		const alwaysShow = Workspace.getConfiguration('eslint').get('alwaysShowStatus', false);
		if (alwaysShow || status !== Status.ok) {
			statusBarItem.show();
		} else {
			statusBarItem.hide();
		}
	}

	function readCodeActionsOnSaveSetting(document: TextDocument): boolean {
		let result: boolean | undefined = undefined;

		function isEnabled(value: CodeActionsOnSave | string[]): boolean | undefined {
			if (value === undefined || value === null) {
				return undefined;
			}
			if (Array.isArray(value)) {
				const result = value.some((element) => { return element === 'source.fixAll.eslint' || element === 'source.fixAll'; });
				return result === true ? true : undefined;
			} else {
				return value['source.fixAll.eslint'] ?? value['source.fixAll'];
			}
		}

		const codeActionsOnSave = Workspace.getConfiguration('editor', document).get<CodeActionsOnSave>('codeActionsOnSave');
		if (codeActionsOnSave !== undefined) {
			result = isEnabled(codeActionsOnSave);
		}
		return result ?? false;
	}

	function migrationFailed(error: any): void {
		client.error(error.message ?? 'Unknown error', error);
		void Window.showErrorMessage('ESLint settings migration failed. Please see the ESLint output channel for further details', 'Open Channel').then((selected) => {
			if (selected === undefined) {
				return;
			}
			client.outputChannel.show();
		});

	}

	async function migrateSettings(): Promise<void> {
		const folders = Workspace.workspaceFolders;
		if (folders === undefined) {
			void Window.showErrorMessage('ESLint settings can only be converted if VS Code is opened on a workspace folder.');
			return;
		}

		const folder = await pickFolder(folders, 'Pick a folder to convert its settings');
		if (folder === undefined) {
			return;
		}
		const migration = new Migration(folder.uri);
		migration.record();
		if (migration.needsUpdate()) {
			try {
				await migration.update();
			} catch (error) {
				migrationFailed(error);
			}
		}
	}


	function parseRulesCustomizations(rawConfig: unknown): RuleCustomization[] {
		if (!rawConfig || !Array.isArray(rawConfig)) {
			return [];
		}

		return rawConfig.map(rawValue => {
			if (typeof rawValue.severity === 'string' && typeof rawValue.rule === 'string') {
				return {
					severity: rawValue.severity,
					rule: rawValue.rule,
				};
			}

			return undefined;
		}).filter((value): value is RuleCustomization => !!value);
	}

	function getRuleCustomizations(config: WorkspaceConfiguration, uri: Uri): RuleCustomization[] {
		let customizations: any = undefined;
		if (uri.scheme === 'vscode-notebook-cell') {
			customizations = config.get('notebooks.rules.customizations', undefined);
		}
		if (customizations === undefined || customizations === null) {
			customizations = config.get('rules.customizations');
		}
		return parseRulesCustomizations(customizations);
	}

	function getTextDocument(uri: Uri): TextDocument | undefined {
		return syncedDocuments.get(uri.toString());

	}



	let defaultErrorHandler: ErrorHandler;
	let serverCalledProcessExit: boolean = false;

	const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
	const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/.eslintr{c.js,c.yaml,c.yml,c,c.json}' };
	const syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();

	let migration: Migration | undefined;
	const migrationSemaphore: Semaphore<void> = new Semaphore<void>(1);
	let notNow: boolean = false;
	const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source.value, CodeActionKind.SourceFixAll.value, `${CodeActionKind.SourceFixAll.value}.eslint`, CodeActionKind.QuickFix.value]);


	try {
		client = new LanguageClient('ESLint', serverOptions, clientOptions);
	} catch (err) {
		void Window.showErrorMessage(`The ESLint extension couldn't be started. See the ESLint output channel for details.`);
		return;
	}
	client.registerFeature(ProposedFeatures.createNotebookDocumentSyncFeature(client));

	Workspace.onDidChangeConfiguration(() => {
		probeFailed.clear();
		for (const textDocument of syncedDocuments.values()) {
			if (computeValidate(textDocument) === Validate.off) {
				const provider = client.getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
				provider?.send(textDocument);
			}
		}
		for (const textDocument of Workspace.textDocuments) {
			if (!syncedDocuments.has(textDocument.uri.toString()) && computeValidate(textDocument) !== Validate.off) {
				try {
					const provider = client.getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument);
				} catch (err) {
					// A feature currently throws if no provider can be found. So for now we catch the exception.
				}
			}
		}
	});

	defaultErrorHandler = client.createDefaultErrorHandler();
	client.onDidChangeState((event) => {
		if (event.newState === ClientState.Starting) {
			client.info('ESLint server is starting');
			serverRunning = undefined;
		} else if (event.newState === ClientState.Running) {
			client.info(running);
			serverRunning = true;
		} else {
			client.info(stopped);
			serverRunning = false;
		}
		updateStatusBar(undefined);
	});

	client.onNotification(ShowOutputChannel.type, () => {
		client.outputChannel.show();
	});

	client.onNotification(StatusNotification.type, (params) => {
		updateDocumentStatus(params);
	});

	client.onNotification(ExitCalled.type, (params) => {
		serverCalledProcessExit = true;
		client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
		void Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, { title: 'Open Output', id: 1}).then((value) => {
			if (value !== undefined && value.id === 1) {
				client.outputChannel.show();
			}
		});
	});

	client.onRequest(NoConfigRequest.type, (params) => {
		const document = Uri.parse(params.document.uri);
		const workspaceFolder = Workspace.getWorkspaceFolder(document);
		const fileLocation = document.fsPath;
		if (workspaceFolder) {
			client.warn([
				'',
				`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
				`File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
				`Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
			].join('\n'));
		} else {
			client.warn([
				'',
				`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
				`File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
			].join('\n'));
		}

		updateDocumentStatus({ uri: params.document.uri, state: Status.error });
		return {};
	});

	client.onRequest(NoESLintLibraryRequest.type, (params) => {
		const key = 'noESLintMessageShown';
		const state = context.globalState.get<NoESLintState>(key, {});

		const uri: Uri = Uri.parse(params.source.uri);
		const workspaceFolder = Workspace.getWorkspaceFolder(uri);
		const packageManager = Workspace.getConfiguration('eslint', uri).get('packageManager', 'npm');
		const localInstall = {
			npm: 'npm install eslint',
			pnpm: 'pnpm install eslint',
			yarn: 'yarn add eslint',
		};
		const globalInstall = {
			npm: 'npm install -g eslint',
			pnpm: 'pnpm install -g eslint',
			yarn: 'yarn global add eslint'
		};
		const isPackageManagerNpm = packageManager === 'npm';
		interface ButtonItem extends MessageItem {
			id: number;
		}
		const outputItem: ButtonItem = {
			title: 'Go to output',
			id: 1
		};
		if (workspaceFolder) {
			client.info([
				'',
				`Failed to load the ESLint library for the document ${uri.fsPath}`,
				'',
				`To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
				`or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
				'',
				isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
				`Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`
			].filter((str => (str !== null))).join('\n'));

			if (state.workspaces === undefined) {
				state.workspaces = {};
			}
			if (!state.workspaces[workspaceFolder.uri.toString()]) {
				state.workspaces[workspaceFolder.uri.toString()] = true;
				void context.globalState.update(key, state);
				void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
					if (item && item.id === 1) {
						client.outputChannel.show(true);
					}
				});
			}
		} else {
			client.info([
				`Failed to load the ESLint library for the document ${uri.fsPath}`,
				`To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
				isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
				'You need to reopen VS Code after installing eslint.',
			].filter((str => (str !== null))).join('\n'));

			if (!state.global) {
				state.global = true;
				void context.globalState.update(key, state);
				void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
					if (item && item.id === 1) {
						client.outputChannel.show(true);
					}
				});
			}
		}
		return {};
	});

	client.onRequest(OpenESLintDocRequest.type, async (params) => {
		await Commands.executeCommand('vscode.open', Uri.parse(params.url));
		return {};
	});

	client.onRequest(ProbeFailedRequest.type, (params) => {
		probeFailed.add(params.textDocument.uri);
		const closeFeature = client.getFeature(DidCloseTextDocumentNotification.method);
		for (const document of Workspace.textDocuments) {
			if (document.uri.toString() === params.textDocument.uri) {
				closeFeature.getProvider(document)?.send(document);
			}
		}
	});

	const notebookFeature = client.getFeature(Proposed.NotebookDocumentSyncRegistrationType.method);
	if (notebookFeature !== undefined) {
		notebookFeature.register({
			id: String(Date.now()),
			registerOptions: {
				notebookSelector: [{
					notebook: { scheme: 'file' }
				}],
				mode: 'notebook'
			}
		});
	}

	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
		onActivateCommands = undefined;
	}

	context.subscriptions.push(
		Window.onDidChangeActiveTextEditor(() => {
			updateStatusBar(undefined);
		}),
		Workspace.onDidCloseTextDocument((document) => {
			const uri = document.uri.toString();
			documentStatus.delete(uri);
			updateStatusBar(undefined);
		}),
		Commands.registerCommand('eslint.executeAutofix', async () => {
			const textEditor = Window.activeTextEditor;
			if (!textEditor) {
				return;
			}
			const textDocument: VersionedTextDocumentIdentifier = {
				uri: textEditor.document.uri.toString(),
				version: textEditor.document.version
			};
			const params: ExecuteCommandParams = {
				command: 'eslint.applyAllFixes',
				arguments: [textDocument]
			};
			await client.start();
			client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
				void Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
			});
		}),
		Commands.registerCommand('eslint.showOutputChannel', async () => {
			client.outputChannel.show();
		}),
		Commands.registerCommand('eslint.migrateSettings', () => {
			void migrateSettings();
		}),
		Commands.registerCommand('eslint.restart', () => {
			client.restart().catch((error) => client.error(`Restarting client failed`, error, 'force'));
		})
	);

	client.start().catch((error) => client.error(`Starting the server failed.`, error, 'force'));
}

export function deactivate() {
	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
	}

	if (taskProvider) {
		taskProvider.dispose();
	}

	return client.stop();
}
