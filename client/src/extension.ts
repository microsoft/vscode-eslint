/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import {
	workspace as Workspace, window as Window, commands as Commands, languages as Languages, Disposable, ExtensionContext, Uri, StatusBarAlignment, TextDocument,
	CodeActionContext, Diagnostic, ProviderResult, Command, QuickPickItem, WorkspaceFolder as VWorkspaceFolder, CodeAction, MessageItem, ConfigurationTarget,
	env as Env
} from 'vscode';
import {
	LanguageClient, LanguageClientOptions, RequestType, TransportKind,
	TextDocumentIdentifier, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, State as ClientState,
	RevealOutputChannelOn, VersionedTextDocumentIdentifier, ExecuteCommandRequest, ExecuteCommandParams,
	ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
	WorkspaceFolder,
} from 'vscode-languageclient';

import { findEslint, glob2RegExp, toOSPath } from './utils';
import { TaskProvider } from './tasks';
import { WorkspaceConfiguration } from 'vscode';

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
		const candidate = item as ValidateItem;
		return candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0);
	}
}

interface DirectoryItem {
	directory: string;
	'!cwd'?: boolean;
}

interface LegacyDirectoryItem extends DirectoryItem {
	changeProcessCWD?: boolean;
}

namespace DirectoryItem {
	export function is(item: any): item is DirectoryItem {
		const candidate = item as DirectoryItem;
		return candidate && Is.string(candidate.directory) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined);
	}
}

type RunValues = 'onType' | 'onSave';

interface CodeActionSettings {
	disableRuleComment: {
		enable: boolean;
		location: 'separateLine' | 'sameLine';
	};
	showDocumentation: {
		enable: boolean;
	};
}

enum Validate {
	on = 'on',
	off = 'off',
	probe = 'probe'
}

interface TextDocumentSettings {
	validate: Validate;
	packageManager: 'npm' | 'yarn' | 'pnpm';
	codeAction: CodeActionSettings;
	codeActionOnSave: boolean;
	format: boolean;
	quiet: boolean;
	options: any | undefined;
	run: RunValues;
	nodePath: string | undefined;
	workspaceFolder: WorkspaceFolder | undefined;
	workingDirectory: DirectoryItem | undefined;
	library: undefined;
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
	state: Status;
}

namespace StatusNotification {
	export const type = new NotificationType<StatusParams, void>('eslint/status');
}

interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type = new RequestType<NoConfigParams, NoConfigResult, void, void>('eslint/noConfig');
}


interface NoESLintLibraryParams {
	source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {
}

namespace NoESLintLibraryRequest {
	export const type = new RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void, void>('eslint/noLibrary');
}

interface OpenESLintDocParams {
	url: string;
}

interface OpenESLintDocResult {

}

namespace OpenESLintDocRequest {
	export const type = new RequestType<OpenESLintDocParams, OpenESLintDocResult, void, void>('eslint/openDoc');
}

interface ProbeFailedParams {
	textDocument: TextDocumentIdentifier;
}

namespace ProbleFailedRequest {
	export const type = new RequestType<ProbeFailedParams, void, void, void>('eslint/probleFailed');
}

const exitCalled = new NotificationType<[number, string], void>('eslint/exitCalled');


interface WorkspaceFolderItem extends QuickPickItem {
	folder: VWorkspaceFolder;
}

async function pickFolder(folders: VWorkspaceFolder[], placeHolder: string): Promise<VWorkspaceFolder | undefined> {
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

function enable() {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		Window.showWarningMessage('ESLint can only be enabled if VS Code is opened on a workspace folder.');
		return;
	}
	const disabledFolders = folders.filter(folder => !Workspace.getConfiguration('eslint', folder.uri).get('enable', true));
	if (disabledFolders.length === 0) {
		if (folders.length === 1) {
			Window.showInformationMessage('ESLint is already enabled in the workspace.');
		} else {
			Window.showInformationMessage('ESLint is already enabled on all workspace folders.');
		}
		return;
	}
	pickFolder(disabledFolders, 'Select a workspace folder to enable ESLint for').then(folder => {
		if (!folder) {
			return;
		}
		Workspace.getConfiguration('eslint', folder.uri).update('enable', true);
	});
}

function disable() {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		Window.showErrorMessage('ESLint can only be disabled if VS Code is opened on a workspace folder.');
		return;
	}
	const enabledFolders = folders.filter(folder => Workspace.getConfiguration('eslint', folder.uri).get('enable', true));
	if (enabledFolders.length === 0) {
		if (folders.length === 1) {
			Window.showInformationMessage('ESLint is already disabled in the workspace.');
		} else {
			Window.showInformationMessage('ESLint is already disabled on all workspace folders.');
		}
		return;
	}
	pickFolder(enabledFolders, 'Select a workspace folder to disable ESLint for').then(folder => {
		if (!folder) {
			return;
		}
		Workspace.getConfiguration('eslint', folder.uri).update('enable', false);
	});
}

function createDefaultConfiguration(): void {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		Window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.');
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
			Window.showInformationMessage('The workspace already contains an ESLint configuration file.');
		} else {
			Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.');
		}
		return;
	}
	pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(async (folder) => {
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

let dummyCommands: Disposable[] | undefined;

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

	const notValidating = () => Window.showInformationMessage('ESLint is not running. By default only JavaScript files are validated. If you want to validate other file types please specify them in the \'eslint.validate\' setting.');
	dummyCommands = [
		Commands.registerCommand('eslint.executeAutofix', notValidating),
		Commands.registerCommand('eslint.showOutputChannel', notValidating)
	];

	context.subscriptions.push(
		Commands.registerCommand('eslint.createConfig', createDefaultConfiguration),
		Commands.registerCommand('eslint.enable', enable),
		Commands.registerCommand('eslint.disable', disable)
	);
	taskProvider = new TaskProvider();
	taskProvider.start();

	configurationChanged();
}

interface InspectData<T> {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T
}
interface MigrationElement<T> {
	changed: boolean;
	value: T | undefined;
}

interface MigrationData<T> {
	global: MigrationElement<T>;
	workspace: MigrationElement<T>;
	workspaceFolder: MigrationElement<T>;
}

interface CodeActionsOnSave {
	'source.fixAll'?: boolean;
	'source.fixAll.eslint'?: boolean;
	[key: string]: boolean | undefined;
}

interface LanguageSettings {
	'editor.codeActionsOnSave'?: CodeActionsOnSave;
}

namespace MigrationData {
	export function create<T>(inspect: InspectData<T> | undefined): MigrationData<T> {
		return inspect === undefined
			? {
				global: { value: undefined, changed: false },
				workspace: { value: undefined, changed: false },
				workspaceFolder: { value: undefined, changed: false }
			}
			: {
				global: { value: inspect.globalValue, changed: false },
				workspace: { value: inspect.workspaceValue, changed: false },
				workspaceFolder: { value: inspect.workspaceFolderValue, changed: false }
			};
	}
	export function needsUpdate(data: MigrationData<any>): boolean {
		return data.global.changed || data.workspace.changed || data.workspaceFolder.changed;
	}
}

class Migration {
	private workspaceConfig: WorkspaceConfiguration;
	private eslintConfig: WorkspaceConfiguration;
	private editorConfig: WorkspaceConfiguration;

	private codeActionOnSave: MigrationData<CodeActionsOnSave>;
	private languageSpecificSettings: Map<string, MigrationData<CodeActionsOnSave>>;

	private autoFixOnSave: MigrationData<boolean>
	private validate: MigrationData<(ValidateItem | string)[]>;

	private workingDirectories: MigrationData<(string | DirectoryItem)[]>;

	private didChangeConfiguration: (() => void) | undefined;

	constructor(resource: Uri) {
		this.workspaceConfig = Workspace.getConfiguration(undefined, resource);
		this.eslintConfig = Workspace.getConfiguration('eslint', resource);
		this.editorConfig = Workspace.getConfiguration('editor', resource);
		this.codeActionOnSave = MigrationData.create(this.editorConfig.inspect<CodeActionsOnSave>('codeActionsOnSave'));
		this.autoFixOnSave = MigrationData.create(this.eslintConfig.inspect<boolean>('autoFixOnSave'));
		this.validate = MigrationData.create(this.eslintConfig.inspect<(ValidateItem | string)[]>('validate'));
		this.workingDirectories = MigrationData.create(this.eslintConfig.inspect<(string | DirectoryItem)[]>('workingDirectories'));
		this.languageSpecificSettings = new Map();
	}

	public record(): void {
		this.recordAutoFixOnSave();
		this.recordValidate();
		this.recordWorkingDirectories();
	}

	public captureDidChangeSetting(func: () => void): void {
		this.didChangeConfiguration = func;
	}

	private recordAutoFixOnSave(): void {
		function record(this: void, elem: MigrationElement<boolean>, setting: MigrationElement<CodeActionsOnSave>): void {
			if (elem.value === undefined) {
				return;
			}

			if (setting.value === undefined) {
				setting.value = {};
			}
			if (elem.value === false || (elem.value === true && !setting.value['source.fixAll'])) {
				setting.value['source.fixAll.eslint'] = elem.value;
				setting.changed = true;
			}
			elem.value = undefined;
			elem.changed = true;
		}

		record(this.autoFixOnSave.global, this.codeActionOnSave.global);
		record(this.autoFixOnSave.workspace, this.codeActionOnSave.workspace);
		record(this.autoFixOnSave.workspaceFolder, this.codeActionOnSave.workspaceFolder);
	}

	private recordValidate(): void {
		function record(this: void, elem: MigrationElement<(ValidateItem | string)[]>, settingAccessor: (language: string) => MigrationElement<CodeActionsOnSave>): void {
			if (elem.value === undefined) {
				return;
			}
			for (let i = 0; i < elem.value.length; i++) {
				const item = elem.value[i];
				if (typeof item === 'string') {
					continue;
				}
				if (item.autoFix === false && typeof item.language === 'string') {
					const setting = settingAccessor(item.language);
					if (setting.value === undefined) {
						setting.value = Object.create(null);
					}
					setting.value![`source.fixAll.eslint`] = false;
					setting.changed = true;
				}
				if (item.language !== undefined) {
					elem.value[i] = item.language;
					elem.changed = true;
				}
			}
		}

		const languageSpecificSettings = this.languageSpecificSettings;
		const workspaceConfig = this.workspaceConfig;
		function getCodeActionsOnSave(language: string): MigrationData<CodeActionsOnSave> {
			let result: MigrationData<CodeActionsOnSave> | undefined = languageSpecificSettings.get(language);
			if (result !== undefined) {
				return result;
			}
			const value: InspectData<LanguageSettings> | undefined = workspaceConfig.inspect(`[${language}]`);
			if (value === undefined) {
				return MigrationData.create(undefined);
			}

			const globalValue = value.globalValue?.['editor.codeActionsOnSave'];
			const workspaceFolderValue = value.workspaceFolderValue?.['editor.codeActionsOnSave'];
			const workspaceValue = value.workspaceValue?.['editor.codeActionsOnSave'];
			result = MigrationData.create<CodeActionsOnSave>({ globalValue, workspaceFolderValue, workspaceValue });
			languageSpecificSettings.set(language, result);
			return result;
		}

		record(this.validate.global, (language) => getCodeActionsOnSave(language).global);
		record(this.validate.workspace, (language) => getCodeActionsOnSave(language).workspace);
		record(this.validate.workspaceFolder, (language) => getCodeActionsOnSave(language).workspaceFolder);
	}

	private recordWorkingDirectories(): void {
		function record(this: void, elem: MigrationElement<(string | DirectoryItem)[]>): void {
			if (elem.value === undefined || !Array.isArray(elem.value)) {
				return;
			}
			for (let i = 0; i < elem.value.length; i++) {
				const item = elem.value[i];
				if (typeof item === 'string') {
					continue;
				}
				if (item['!cwd'] !== undefined) {
					continue;
				}
				const legacy: LegacyDirectoryItem = item;
				if (legacy.changeProcessCWD !== undefined) {
					if (legacy.changeProcessCWD === false) {
						item['!cwd'] = true;
						elem.changed = true;
					}
				}
				if (item['!cwd'] === undefined) {
					elem.value[i] = item.directory;
					elem.changed = true;
				}
			}
		}

		record(this.workingDirectories.global);
		record(this.workingDirectories.workspace);
		record(this.workingDirectories.workspaceFolder);
	}

	public needsUpdate(): boolean {
		if (MigrationData.needsUpdate(this.autoFixOnSave) ||
			MigrationData.needsUpdate(this.validate) ||
			MigrationData.needsUpdate(this.codeActionOnSave) ||
			MigrationData.needsUpdate(this.workingDirectories)
		) {
			return true;
		}
		for (const value of this.languageSpecificSettings.values()) {
			if (MigrationData.needsUpdate(value)) {
				return true;
			}
		}
		return false;
	}

	public async update(): Promise<void> {
		async function _update<T>(config: WorkspaceConfiguration, section: string, newValue: MigrationElement<T>, target: ConfigurationTarget): Promise<void> {
			if (!newValue.changed) {
				return;
			}
			await config.update(section, newValue.value, target);
		}

		async function _updateLanguageSetting(config: WorkspaceConfiguration, section: string, settings: LanguageSettings | undefined, newValue: MigrationElement<CodeActionsOnSave>, target: ConfigurationTarget): Promise<void> {
			if (!newValue.changed) {
				return;
			}

			if (settings === undefined) {
				settings = Object.create(null) as object;
			}
			if (settings['editor.codeActionsOnSave'] === undefined) {
				settings['editor.codeActionsOnSave'] = {};
			}
			settings['editor.codeActionsOnSave'] = newValue.value;
			await config.update(section, settings, target);
		}

		try {
			await _update(this.editorConfig, 'codeActionsOnSave', this.codeActionOnSave.global, ConfigurationTarget.Global);
			await _update(this.editorConfig, 'codeActionsOnSave', this.codeActionOnSave.workspace, ConfigurationTarget.Workspace);
			await _update(this.editorConfig, 'codeActionsOnSave', this.codeActionOnSave.workspaceFolder, ConfigurationTarget.WorkspaceFolder);

			await _update(this.eslintConfig, 'autoFixOnSave', this.autoFixOnSave.global, ConfigurationTarget.Global);
			await _update(this.eslintConfig, 'autoFixOnSave', this.autoFixOnSave.workspace, ConfigurationTarget.Workspace);
			await _update(this.eslintConfig, 'autoFixOnSave', this.autoFixOnSave.workspaceFolder, ConfigurationTarget.WorkspaceFolder);

			await _update(this.eslintConfig, 'validate', this.validate.global, ConfigurationTarget.Global);
			await _update(this.eslintConfig, 'validate', this.validate.workspace, ConfigurationTarget.Workspace);
			await _update(this.eslintConfig, 'validate', this.validate.workspaceFolder, ConfigurationTarget.WorkspaceFolder);

			await _update(this.eslintConfig, 'workingDirectories', this.workingDirectories.global, ConfigurationTarget.Global);
			await _update(this.eslintConfig, 'workingDirectories', this.workingDirectories.workspace, ConfigurationTarget.Workspace);
			await _update(this.eslintConfig, 'workingDirectories', this.workingDirectories.workspaceFolder, ConfigurationTarget.WorkspaceFolder);

			for (const language of this.languageSpecificSettings.keys()) {
				const value = this.languageSpecificSettings.get(language)!;
				if (MigrationData.needsUpdate(value)) {
					const section = `[${language}]`;
					const current = this.workspaceConfig.inspect<LanguageSettings>(section);
					await _updateLanguageSetting(this.workspaceConfig, section, current?.globalValue, value.global, ConfigurationTarget.Global);
					await _updateLanguageSetting(this.workspaceConfig, section, current?.workspaceValue, value.workspace, ConfigurationTarget.Workspace);
					await _updateLanguageSetting(this.workspaceConfig, section, current?.workspaceFolderValue, value.workspaceFolder, ConfigurationTarget.WorkspaceFolder);
				}
			}
		} finally {
			if (this.didChangeConfiguration) {
				this.didChangeConfiguration();
				this.didChangeConfiguration = undefined;
			}
		}
	}
}

function realActivate(context: ExtensionContext): void {

	const statusBarItem = Window.createStatusBarItem(StatusBarAlignment.Right, 0);
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
		eslintStatus = status;
		switch (status) {
			case Status.ok:
				statusBarItem.text = 'ESLint';
				break;
			case Status.warn:
				statusBarItem.text = '$(alert) ESLint';
				break;
			case Status.error:
				statusBarItem.text = '$(issue-opened) ESLint';
				break;
			default:
				statusBarItem.text = 'ESLint';
		}
		updateStatusBarVisibility();
	}

	function updateStatusBarVisibility(): void {
		showStatusBarItem(
			(serverRunning && eslintStatus !== Status.ok) || Workspace.getConfiguration('eslint').get('alwaysShowStatus', false)
		);
	}

	function readCodeActionsOnSaveSetting(document: TextDocument): boolean {
		let result: boolean | undefined = undefined;
		const languageConfig = Workspace.getConfiguration(undefined, document.uri).get<LanguageSettings>(`[${document.languageId}]`);
		if (languageConfig !== undefined) {
			const codeActionsOnSave = languageConfig?.['editor.codeActionsOnSave'];
			if (codeActionsOnSave !== undefined) {
				result = codeActionsOnSave['source.fixAll.eslint'] ?? codeActionsOnSave['source.fixAll'];
			}
		}
		if (result === undefined) {
			const codeActionsOnSave = Workspace.getConfiguration('editor', document.uri).get<CodeActionsOnSave>('codeActionsOnSave');
			if (codeActionsOnSave !== undefined) {
				result = codeActionsOnSave[`source.fixAll.eslint`] ?? codeActionsOnSave['source.fixAll'];
			}
		}
		return result ?? false;
	}

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	// serverModule
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'eslintServer.js'));
	const eslintConfig = Workspace.getConfiguration('eslint');
	const runtime = eslintConfig.get('runtime', undefined);
	const debug = eslintConfig.get('debug');

	let env: { [key: string]: string | number | boolean } | undefined;
	if (debug) {
		env = {
			DEBUG: 'eslint:*,-eslint:code-path'
		};
	}
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc, runtime, options: { cwd: process.cwd(), env } },
		debug: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv: ['--nolazy', '--inspect=6011'], cwd: process.cwd(), env } }
	};

	let defaultErrorHandler: ErrorHandler;
	let serverCalledProcessExit: boolean = false;

	const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
	const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/.eslintr{c.js,c.yaml,c.yml,c,c.json}' };
	const syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();

	Workspace.onDidChangeConfiguration(() => {
		probeFailed.clear();
		for (const textDocument of syncedDocuments.values()) {
			if (computeValidate(textDocument) === Validate.off) {
				syncedDocuments.delete(textDocument.uri.toString());
				client.sendNotification(DidCloseTextDocumentNotification.type, client.code2ProtocolConverter.asCloseTextDocumentParams(textDocument));
			}
		}
		for (const textDocument of Workspace.textDocuments) {
			if (!syncedDocuments.has(textDocument.uri.toString()) && computeValidate(textDocument) !== Validate.off) {
				client.sendNotification(DidOpenTextDocumentNotification.type, client.code2ProtocolConverter.asOpenTextDocumentParams(textDocument));
				syncedDocuments.set(textDocument.uri.toString(), textDocument);
			}
		}
	});

	let migration: Migration | undefined;
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
		diagnosticCollectionName: 'eslint',
		revealOutputChannelOn: RevealOutputChannelOn.Never,
		initializationOptions: {
		},
		progressOnInitialization: true,
		synchronize: {
			// configurationSection: 'eslint',
			fileEvents: [
				Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}'),
				Workspace.createFileSystemWatcher('**/.eslintignore'),
				Workspace.createFileSystemWatcher('**/package.json')
			]
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
		},
		middleware: {
			didOpen: (document, next) => {
				if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || computeValidate(document) !== Validate.off) {
					next(document);
					syncedDocuments.set(document.uri.toString(), document);
					return;
				}
			},
			didChange: (event, next) => {
				if (syncedDocuments.has(event.document.uri.toString())) {
					next(event);
				}
			},
			willSave: (event, next) => {
				if (syncedDocuments.has(event.document.uri.toString())) {
					next(event);
				}
			},
			willSaveWaitUntil: (event, next) => {
				if (syncedDocuments.has(event.document.uri.toString())) {
					return next(event);
				} else {
					return Promise.resolve([]);
				}
			},
			didSave: (document, next) => {
				if (syncedDocuments.has(document.uri.toString())) {
					next(document);
				}
			},
			didClose: (document, next) => {
				const uri = document.uri.toString();
				if (syncedDocuments.has(uri)) {
					syncedDocuments.delete(uri);
					next(document);
				}
			},
			provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
				if (!syncedDocuments.has(document.uri.toString())) {
					return [];
				}
				if (context.only !== undefined && context.only.value !== 'source' && context.only.value !== 'source.fixAll' && context.only.value !== 'source.fixAll.eslint') {
					return [];
				}
				if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
					return [];
				}
				const eslintDiagnostics: Diagnostic[] = [];
				for (const diagnostic of context.diagnostics) {
					if (diagnostic.source === 'eslint') {
						eslintDiagnostics.push(diagnostic);
					}
				}
				if (context.only === undefined && eslintDiagnostics.length === 0) {
					return [];
				}
				const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics } as CodeActionContext);
				return next(document, range, newContext, token);
			},
			workspace: {
				didChangeWatchedFile: (event, next) => {
					probeFailed.clear();
					next(event);
				},
				didChangeConfiguration: (sections, next) => {
					if (migration !== undefined && (sections === undefined || sections.length === 0)) {
						migration.captureDidChangeSetting(() => {
							next(sections);
						});
						return;
					} else {
						next(sections);
					}
				},
				configuration: async (params, _token, _next): Promise<any[]> => {
					if (params.items === undefined) {
						return [];
					}
					const result: (TextDocumentSettings | null)[] = [];
					for (const item of params.items) {
						if (item.section || !item.scopeUri) {
							result.push(null);
							continue;
						}
						const resource = client.protocol2CodeConverter.asUri(item.scopeUri);
						try {
							migration = new Migration(resource);
							migration.record();
							if (migration.needsUpdate()) {
								try {
									await migration.update();
									Window.showInformationMessage('ESLint settings got converted to new code action format. See the ESLint extension documentation for more information.', 'Open ReadMe').then((selected) => {
										if (selected === undefined) {
											return;
										}
										Env.openExternal(Uri.parse('https://github.com/microsoft/vscode-eslint/blob/master/README.md'));
									});
								} catch (error) {
									client.error(error.message ?? 'Unknown error', error);
									Window.showErrorMessage('ESLint settings migration failed. Please see the ESLint output channel for further details', 'Open Channel').then((selected) => {
										if (selected === undefined) {
											return;
										}
										client.outputChannel.show();
									});
								}
							}
						} finally {
							migration = undefined;
						}
						const config = Workspace.getConfiguration('eslint', resource);
						const settings: TextDocumentSettings = {
							validate: Validate.off,
							packageManager: config.get('packageManager', 'npm'),
							codeActionOnSave: false,
							format: false,
							quiet: config.get('quiet', false),
							options: config.get('options', {}),
							run: config.get('run', 'onType'),
							nodePath: config.get('nodePath', undefined),
							workingDirectory: undefined,
							workspaceFolder: undefined,
							library: undefined,
							codeAction: {
								disableRuleComment: config.get('codeAction.disableRuleComment', { enable: true, location: 'separateLine' as 'separateLine' }),
								showDocumentation: config.get('codeAction.showDocumentation', { enable: true })
							}
						};
						const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri);
						if (document === undefined) {
							result.push(settings);
							continue;
						}
						if (config.get('enabled', true)) {
							settings.validate = computeValidate(document);
						}
						if (settings.validate !== Validate.off) {
							settings.format = !!config.get('format.enable', false);
							settings.codeActionOnSave = readCodeActionsOnSaveSetting(document);
						}
						const workspaceFolder = Workspace.getWorkspaceFolder(resource);
						if (workspaceFolder) {
							settings.workspaceFolder = {
								name: workspaceFolder.name,
								uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
							};
						}
						const workingDirectories = config.get<(string | DirectoryItem)[] | undefined>('workingDirectories', undefined);
						if (Array.isArray(workingDirectories)) {
							let workingDirectory: DirectoryItem | undefined = undefined;
							const workspaceFolderPath = workspaceFolder && workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
							for (const entry of workingDirectories) {
								let directory;
								let noCWD = false;
								if (Is.string(entry)) {
									directory = entry;
								}
								else if (DirectoryItem.is(entry)) {
									directory = entry.directory;
									noCWD = entry['!cwd'] ?? false;
								}
								if (directory) {
									directory = toOSPath(directory);
									if (path.isAbsolute(directory)) {
										directory = directory;
									}
									else if (workspaceFolderPath && directory) {
										directory = path.join(workspaceFolderPath, directory);
									}
									else {
										directory = undefined;
									}
									const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
									if (filePath !== undefined) {
										const regExp: RegExp | undefined = directory !== undefined
											? new RegExp(glob2RegExp(directory))
											: undefined;
										if (regExp !== undefined) {
											const match = regExp.exec(filePath);
											if (match !== null && match.length > 0) {
												directory = match[0];
												if (workingDirectory) {
													if (workingDirectory.directory.length < directory.length) {
														workingDirectory.directory = directory;
														workingDirectory['!cwd'] = noCWD;
													}
												} else {
													workingDirectory = { directory, '!cwd': noCWD };
												}
											}
										}
									}
								}
							}
							settings.workingDirectory = workingDirectory;
						}
						result.push(settings);
					}
					return result;
				}
			}
		}
	};

	let client: LanguageClient;
	try {
		client = new LanguageClient('ESLint', serverOptions, clientOptions);
	} catch (err) {
		Window.showErrorMessage(`The ESLint extension couldn't be started. See the ESLint output channel for details.`);
		return;
	}
	client.registerProposedFeatures();
	defaultErrorHandler = client.createDefaultErrorHandler();
	const running = 'ESLint server is running.';
	const stopped = 'ESLint server stopped.';
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
		updateStatusBarVisibility();
	});
	client.onReady().then(() => {
		client.onNotification(StatusNotification.type, (params) => {
			updateStatus(params.state);
		});

		client.onNotification(exitCalled, (params) => {
			serverCalledProcessExit = true;
			client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
			Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`);
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
			eslintStatus = Status.warn;
			updateStatusBarVisibility();
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
					context.globalState.update(key, state);
					Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
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
					context.globalState.update(key, state);
					Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			}
			return {};
		});

		client.onRequest(OpenESLintDocRequest.type, (params) => {
			Commands.executeCommand('vscode.open', Uri.parse(params.url));
			return {};
		});

		client.onRequest(ProbleFailedRequest.type, (params) => {
			probeFailed.add(params.textDocument.uri);
			const closeFeature = client.getFeature(DidCloseTextDocumentNotification.method);
			for (const document of Workspace.textDocuments) {
				if (document.uri.toString() === params.textDocument.uri) {
					closeFeature.getProvider(document).send(document);
				}
			}
		});
	});

	if (dummyCommands) {
		dummyCommands.forEach(command => command.dispose());
		dummyCommands = undefined;
	}

	updateStatusBarVisibility();

	context.subscriptions.push(
		client.start(),
		Commands.registerCommand('eslint.executeAutofix', () => {
			const textEditor = Window.activeTextEditor;
			if (!textEditor) {
				return;
			}
			const textDocument: VersionedTextDocumentIdentifier = {
				uri: textEditor.document.uri.toString(),
				version: textEditor.document.version
			};
			const params: ExecuteCommandParams = {
				command: 'eslint.applyAutoFix',
				arguments: [textDocument]
			};
			client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
				Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
			});
		}),
		Commands.registerCommand('eslint.showOutputChannel', () => { client.outputChannel.show(); }),
		statusBarItem
	);
}

export function deactivate() {
	if (dummyCommands) {
		dummyCommands.forEach(command => command.dispose());
	}

	if (taskProvider) {
		taskProvider.dispose();
	}
}
