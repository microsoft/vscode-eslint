/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import {
	workspace as Workspace, window as Window, commands as Commands, languages as Languages, Disposable, ExtensionContext, Uri,
	StatusBarAlignment, TextDocument, CodeActionContext, Diagnostic, ProviderResult, Command, QuickPickItem,
	WorkspaceFolder as VWorkspaceFolder, CodeAction, MessageItem, ConfigurationTarget, env as Env, CodeActionKind, DiagnosticSeverity as VDiagnosticSeverity,
	WorkspaceConfiguration, DiagnosticCollection, Range, TextEditor, Position
} from 'vscode';
import {
	LanguageClient, LanguageClientOptions, RequestType, TransportKind, TextDocumentIdentifier, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, State as ClientState, RevealOutputChannelOn, VersionedTextDocumentIdentifier, ExecuteCommandRequest,
	ExecuteCommandParams, ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
	WorkspaceFolder, DidChangeConfigurationNotification
} from 'vscode-languageclient/node';

import { findEslint, convert2RegExp, toOSPath, toPosixPath, Semaphore } from './utils';
import { TaskProvider } from './tasks';

namespace Is {
	const toString = Object.prototype.toString;

	export function boolean(value: any): value is boolean {
		return value === true || value === false;
	}

	export function string(value: any): value is string {
		return toString.call(value) === '[object String]';
	}

	export function objectLiteral(value: any): value is object {
		return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object';
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

interface LegacyDirectoryItem {
	directory: string;
	changeProcessCWD: boolean;
}

namespace LegacyDirectoryItem {
	export function is(item: any): item is LegacyDirectoryItem {
		const candidate = item as LegacyDirectoryItem;
		return candidate && Is.string(candidate.directory) && Is.boolean(candidate.changeProcessCWD);
	}
}

enum ModeEnum {
	auto = 'auto',
	location = 'location'
}

namespace ModeEnum {
	export function is(value: string): value is ModeEnum {
		return value === ModeEnum.auto || value === ModeEnum.location;
	}
}

interface ModeItem {
	mode: ModeEnum
}

namespace ModeItem {
	export function is(item: any): item is ModeItem {
		const candidate = item as ModeItem;
		return candidate && ModeEnum.is(candidate.mode);
	}
}

interface DirectoryItem {
	directory: string;
	'!cwd'?: boolean;
}

namespace DirectoryItem {
	export function is(item: any): item is DirectoryItem {
		const candidate = item as DirectoryItem;
		return candidate && Is.string(candidate.directory) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined);
	}
}

interface PatternItem {
	pattern: string;
	'!cwd'?: boolean;
}

namespace PatternItem {
	export function is(item: any): item is PatternItem {
		const candidate = item as PatternItem;
		return candidate && Is.string(candidate.pattern) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined);
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

enum CodeActionsOnSaveMode {
	all = 'all',
	problems = 'problems'
}

namespace CodeActionsOnSaveMode {
	export function from(value: string): CodeActionsOnSaveMode {
		switch(value.toLowerCase()) {
			case CodeActionsOnSaveMode.problems:
				return CodeActionsOnSaveMode.problems;
			default:
				return CodeActionsOnSaveMode.all;
		}
	}
}

interface CodeActionsOnSaveSettings {
	enable: boolean;
	mode: CodeActionsOnSaveMode
}

enum Validate {
	on = 'on',
	off = 'off',
	probe = 'probe'
}

enum ESLintSeverity {
	off = 'off',
	warn = 'warn',
	error = 'error'
}

namespace ESLintSeverity {
	export function from(value: string): ESLintSeverity {
		switch (value.toLowerCase()) {
			case ESLintSeverity.off:
				return ESLintSeverity.off;
			case ESLintSeverity.warn:
				return ESLintSeverity.warn;
			case ESLintSeverity.error:
				return ESLintSeverity.error;
			default:
				return ESLintSeverity.off;
		}
	}
}

enum ConfirmationSelection {
	doNotTrust = 1,
	trust = 2,
	alwaysTrust = 3
}

interface ConfigurationSettings {
	validate: Validate;
	packageManager: 'npm' | 'yarn' | 'pnpm';
	codeAction: CodeActionSettings;
	codeActionOnSave: CodeActionsOnSaveSettings;
	format: boolean;
	quiet: boolean;
	onIgnoredFiles: ESLintSeverity;
	options: any | undefined;
	run: RunValues;
	nodePath: string | null;
	workspaceFolder: WorkspaceFolder | undefined;
	workingDirectory: ModeItem | DirectoryItem | undefined;
}

interface NoESLintState {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
}

enum Status {
	ok = 1,
	warn = 2,
	error = 3,
	notConfirmed = 4
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

namespace ProbeFailedRequest {
	export const type = new RequestType<ProbeFailedParams, void, void, void>('eslint/probeFailed');
}

interface ESLintLibraryState {
	libs: { [key: string]: boolean };
}

interface ConfirmESLintLibraryParams {
	scope: 'local' | 'global';
	uri: string;
	libraryPath: string;
}

namespace ConfirmESLintLibrary {
	export const type = new RequestType<ConfirmESLintLibraryParams, boolean, void, void>('eslint/confirmLocalESLint');
}

const exitCalled = new NotificationType<[number, string], void>('eslint/exitCalled');


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

const eslintLibraryKey = 'eslintLibraries';
let eslintLibraryState: ESLintLibraryState;

const eslintAlwaysAllowLibraryKey = 'eslintAlwaysAllowLibraries';
let eslintAlwaysAllowLibraryState: boolean = false;

const sessionState: Map<string, ConfirmESLintLibraryParams> = new Map();
const canceledLibraries: Map<string, boolean> = new Map();
const pendingUris2LibraryParams: Map<string, ConfirmESLintLibraryParams> = new Map();
type PendingLibraryInfo = {
	params: ConfirmESLintLibraryParams;
	pendingUris: Set<string>;
	libErrorUri: Uri | undefined;
	editorErrorUri: Uri | undefined;
	diagnostics: DiagnosticCollection;
	codeActionProvider: Disposable | undefined;
	libCodeActionProvider: Disposable | undefined;
};
const libraryPath2PendingLibraryInfo: Map<string, PendingLibraryInfo> = new Map();
let lastPendingEditorInfo: PendingLibraryInfo | undefined;
const libraryPathMapping: Map<string, string> = new Map();

function isTrusted(params: ConfirmESLintLibraryParams): boolean | undefined {
	const state = eslintLibraryState.libs[params.libraryPath];
	if (state === false || state === true) {
		return state;
	}
	const canceled = canceledLibraries.get(params.libraryPath);
	if (canceled === false) {
		return false;
	}
	return undefined;
}

const flaggedLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
function checkDiagnosticState(params: ConfirmESLintLibraryParams | undefined, editor: TextEditor | undefined): void {

	function handleEditor(editor: TextEditor): boolean {
		const uri = editor.document.uri.toString();
		const params = pendingUris2LibraryParams.get(uri);
		if (params === undefined) {
			return false;
		}
		const info = libraryPath2PendingLibraryInfo.get(params.libraryPath);
		if (info === undefined) {
			return false;
		}

		if (info.pendingUris.has(uri) && info.editorErrorUri?.toString() !== uri.toString()) {
			const range = editor.document.getWordRangeAtPosition(new Position(0, 0)) ?? new Range(0,0,0,0);
			const diagnostic = new Diagnostic(
				range,
				'ESLint is disabled since its execution has not been approved or rejected yet. Use the light bulb menu to open the approval dialog.', VDiagnosticSeverity.Warning
			);
			diagnostic.source = 'eslint';
			const errorUri = editor.document.uri;

			info.diagnostics.set(errorUri, [diagnostic]);
			if (info.editorErrorUri !== undefined) {
				info.diagnostics.delete(info.editorErrorUri);
			}
			info.editorErrorUri = errorUri;
			if (info.codeActionProvider !== undefined) {
				info.codeActionProvider.dispose();
			}
			info.codeActionProvider =  Languages.registerCodeActionsProvider({ pattern: errorUri.fsPath }, {
				provideCodeActions: (_document, _range, context) => {
					for (const diag of context.diagnostics) {
						if (diag === diagnostic) {
							const result = new CodeAction('ESLint: Approve execution', CodeActionKind.QuickFix);
							result.isPreferred = true;
							result.command = {
								title: 'Confirm ESLint execution',
								command: 'eslint.confirmExecution',
								arguments: [params]
							};
							return [result];
						}
					}
					return [];
				}
			});
			lastPendingEditorInfo = info;
		}
		return true;
	}
	let editorError: boolean = false;
	if (lastPendingEditorInfo !== undefined && (editor === undefined || !flaggedLanguages.has(editor.document.languageId))) {
		if (lastPendingEditorInfo.codeActionProvider !== undefined) {
			lastPendingEditorInfo.codeActionProvider.dispose();
			lastPendingEditorInfo.codeActionProvider = undefined;
		}
		if (lastPendingEditorInfo.editorErrorUri !== undefined) {
			lastPendingEditorInfo.diagnostics.delete(lastPendingEditorInfo.editorErrorUri);
			lastPendingEditorInfo.editorErrorUri = undefined;
		}
		lastPendingEditorInfo = undefined;
	}
	if (editor !== undefined && flaggedLanguages.has(editor.document.languageId)) {
		editorError = handleEditor(editor);
	}

	function handleParams(params: ConfirmESLintLibraryParams): void {
		const contentPath = path.join(path.dirname(params.libraryPath), 'info.txt');
		libraryPathMapping.set(contentPath, params.libraryPath);
		const uri = Uri.parse(contentPath).with({ scheme: 'eslint-error'});
		const info = libraryPath2PendingLibraryInfo.get(params.libraryPath);
		if (info === undefined || info.diagnostics.has(uri)) {
			return;
		}
		const diagnostic = new Diagnostic(
			new Range(0,0,0,6),
			'ESLint is disabled since its execution has not been approved or rejected yet. Click this problem to open the approval dialog.', VDiagnosticSeverity.Warning
		);
		info.diagnostics.set(uri, [diagnostic]);
		info.libErrorUri = uri;

		if (info.libCodeActionProvider !== undefined) {
			info.libCodeActionProvider.dispose();
		}
	}

	if (params !== undefined && !editorError) {
		handleParams(params);
	}
}

function clearInfo(info: PendingLibraryInfo): void {
	info.diagnostics.clear();
	if (info.codeActionProvider !== undefined) {
		info.codeActionProvider.dispose();
	}
	if (info.libCodeActionProvider !== undefined) {
		info.libCodeActionProvider.dispose();
	}
}

function clearDiagnosticState(params: ConfirmESLintLibraryParams): void {
	const info = libraryPath2PendingLibraryInfo.get(params.libraryPath);
	if (info === undefined) {
		return;
	}
	libraryPath2PendingLibraryInfo.delete(params.libraryPath);
	clearInfo(info);

}

function clearAllDiagnosticState(): void {
	pendingUris2LibraryParams.clear();
	// Make a copy
	for (const info of Array.from(libraryPath2PendingLibraryInfo.values())) {
		clearInfo(info);
	}
	libraryPath2PendingLibraryInfo.clear();
}

async function askForLibraryConfirmation(client: LanguageClient | undefined, context: ExtensionContext, params: ConfirmESLintLibraryParams, modal: boolean, updateStatus: undefined | ((status: Status) => void)): Promise<void> {
	const trusted = isTrusted(params);
	if (trusted !== undefined) {
		return;
	}
	sessionState.set(params.libraryPath, params);

	// Reevaluate state and cancel since the information meessage is async
	const libraryUri = Uri.file(params.libraryPath);
	const folder = Workspace.getWorkspaceFolder(libraryUri);

	interface ConfirmMessageItem extends MessageItem {
		value: ConfirmationSelection;
	}
	let message: string;
	let alwaysAllow: boolean = false;
	if (folder !== undefined) {
		let relativePath = libraryUri.toString().substr(folder.uri.toString().length + 1);
		const mainPath = '/lib/api.js';
		if (relativePath.endsWith(mainPath)) {
			relativePath = relativePath.substr(0, relativePath.length - mainPath.length);
		}
		alwaysAllow = true;
		message = modal
		 ? `The ESLint extension will use '${relativePath}' for validation, which is installed locally in '${folder.name}'. Do you trust this version of ESLint including all plugins and configuration files it will load and execute on your behave?\n\nPress 'Always Trust' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`
		 : `The ESLint extension will use '${relativePath}' for validation, which is installed locally in '${folder.name}'. Do you trust this version of ESLint including all plugins and configuration files it will load and execute on your behave? Press 'Always Trust' to remember the choice for all workspaces. Closing the notification will disable ESLint for this session.`;
	} else {
		message = params.scope === 'global'
			? `The ESLint extension will use a globally installed ESLint library for validation. Do you trust this version of ESLint including all plugins and configuration files it will load and execute on your behave?\n\nPress 'Always Trust' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`
			: `The ESLint extension will use a locally installed ESLint library for validation. Do you trust this version of ESLint including all plugins and configuration files it will load and execute on your behave?\n\nPress 'Always Trust' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`;
	}
	const messageItems: ConfirmMessageItem[] = alwaysAllow
		? [{ title: 'Always Trust', value: ConfirmationSelection.alwaysTrust }, { title: 'Trust', value: ConfirmationSelection.trust }, { title: 'Do Not Trust', value: ConfirmationSelection.doNotTrust }]
		: [{ title: 'Trust', value: ConfirmationSelection.trust }, { title: 'Do Not Trust', value: ConfirmationSelection.doNotTrust }];

	const item = await Window.showInformationMessage<ConfirmMessageItem>(message, { modal: modal }, ...messageItems);
	if (item === undefined) {
		canceledLibraries.set(params.libraryPath, false);
		clearDiagnosticState(params);
		updateStatus && updateStatus(Status.notConfirmed);
	} else {
		if (item.value === ConfirmationSelection.trust || item.value === ConfirmationSelection.doNotTrust) {
			const value = item.value === ConfirmationSelection.trust ? true : false;
			eslintLibraryState.libs[params.libraryPath] = value;
			context.globalState.update(eslintLibraryKey, eslintLibraryState);
			clearDiagnosticState(params);
		} else if (item.value === ConfirmationSelection.alwaysTrust) {
			eslintAlwaysAllowLibraryState = true;
			context.globalState.update(eslintAlwaysAllowLibraryKey, eslintAlwaysAllowLibraryState);
			clearAllDiagnosticState();
		}
		updateStatus && updateStatus(Status.ok);
	}
	const newTrusted = isTrusted(params);
	if (trusted !== newTrusted && client !== undefined) {
		client.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
	}
}

async function manageLibraryConfirmations(client: LanguageClient | undefined, context: ExtensionContext): Promise<void> {
	interface ESLintQuickPickItem extends QuickPickItem {
		kind: 'all' | 'allConfirmed' | 'allRejected' | 'session' | 'alwaysAllow';
	}
	const items: ESLintQuickPickItem[] = [
		{ label: 'Reset ESLint library decisions for this workspace', kind: 'session' },
		{ label: 'Reset all ESLint library decisions', kind: 'all' }
	];
	if (eslintAlwaysAllowLibraryState) {
		items.splice(1, 0, { label: 'Reset Always Allow all ESlint libraries decision', kind: 'alwaysAllow'});
	}
	const selected = await Window.showQuickPick<ESLintQuickPickItem>(items, { placeHolder: 'Clear library confirmations'});
	if (selected !== undefined) {
		switch (selected.kind) {
			case 'all':
				eslintLibraryState.libs = {};
				eslintAlwaysAllowLibraryState = false;
				break;
			case 'alwaysAllow':
				eslintAlwaysAllowLibraryState = false;
				break;
			case 'session':
				for (const lib of sessionState.keys()) {
					delete eslintLibraryState.libs[lib];
				}
				break;
		}
		context.globalState.update(eslintLibraryKey, eslintLibraryState);
		context.globalState.update(eslintAlwaysAllowLibraryKey, eslintAlwaysAllowLibraryState);
		canceledLibraries.clear();
		const currentSessionState = new Map(sessionState);
		sessionState.clear();
		for (const state of currentSessionState) {
			const trusted = isTrusted(state[1]);
			if (trusted === undefined) {
				await askForLibraryConfirmation(client, context, state[1], true, undefined);
			}
		}
		if (client !== undefined) {
			client.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
		}
	}
}

export function activate(context: ExtensionContext) {
	eslintLibraryState =  context.globalState.get<ESLintLibraryState>(eslintLibraryKey, { libs: {} });
	eslintAlwaysAllowLibraryState = context.globalState.get<boolean>(eslintAlwaysAllowLibraryKey, false);

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
	onActivateCommands = [
		Commands.registerCommand('eslint.executeAutofix', notValidating),
		Commands.registerCommand('eslint.showOutputChannel', notValidating),
		Commands.registerCommand('eslint.manageLibraryConfirmations', () => {
			manageLibraryConfirmations(undefined, context);
		})
	];

	context.subscriptions.push(
		Commands.registerCommand('eslint.createConfig', createDefaultConfiguration),
		Commands.registerCommand('eslint.enable', enable),
		Commands.registerCommand('eslint.disable', disable),
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

interface CodeActionsOnSaveMap {
	'source.fixAll'?: boolean;
	'source.fixAll.eslint'?: boolean;
	[key: string]: boolean | undefined;
}

type CodeActionsOnSave = CodeActionsOnSaveMap | string[] | null;

namespace CodeActionsOnSave {
	export function isExplicitlyDisabled(setting: CodeActionsOnSave | undefined): boolean {
		if (setting === undefined || setting === null || Array.isArray(setting)) {
			return false;
		}
		return setting['source.fixAll.eslint'] === false;
	}

	export function getSourceFixAll(setting: CodeActionsOnSave): boolean | undefined {
		if (setting === null) {
			return undefined;
		} if (Array.isArray(setting)) {
			return setting.includes('source.fixAll') ? true : undefined;
		} else {
			return setting['source.fixAll'];
		}
	}

	export function getSourceFixAllESLint(setting: CodeActionsOnSave): boolean | undefined {
		if (setting === null) {
			return undefined;
		} else if (Array.isArray(setting)) {
			return setting.includes('source.fixAll.eslint') ? true : undefined;
		} else {
			return setting['source.fixAll.eslint'];
		}
	}

	export function setSourceFixAllESLint(setting: CodeActionsOnSave, value: boolean | undefined): void {
		// If the setting is mistyped do nothing.
		if (setting === null) {
			return;
		} else  if (Array.isArray(setting)) {
			const index = setting.indexOf('source.fixAll.eslint');
			if (value === true) {
				if (index === -1) {
					setting.push('source.fixAll.eslint');
				}
			} else {
				if (index >= 0) {
					setting.splice(index, 1);
				}
			}
		} else {
			setting['source.fixAll.eslint'] = value;
		}
	}
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

	private autoFixOnSave: MigrationData<boolean>;
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
		const fixAll = this.recordAutoFixOnSave();
		this.recordValidate(fixAll);
		this.recordWorkingDirectories();
	}

	public captureDidChangeSetting(func: () => void): void {
		this.didChangeConfiguration = func;
	}

	private recordAutoFixOnSave(): [boolean, boolean, boolean] {
		function record(this: void, elem: MigrationElement<boolean>, setting: MigrationElement<CodeActionsOnSave>): boolean {
			// if it is explicitly set to false don't convert anything anymore
			if (CodeActionsOnSave.isExplicitlyDisabled(setting.value)) {
				return false;
			}
			if (!Is.objectLiteral(setting.value) && !Array.isArray(setting.value)) {
				setting.value = Object.create(null) as {};
			}
			const autoFix: boolean = !!elem.value;
			const sourceFixAll: boolean = !!CodeActionsOnSave.getSourceFixAll(setting.value);
			let result: boolean;
			if (autoFix !== sourceFixAll && autoFix && CodeActionsOnSave.getSourceFixAllESLint(setting.value) === undefined) {
				CodeActionsOnSave.setSourceFixAllESLint(setting.value, elem.value);
				setting.changed = true;
				result = !!CodeActionsOnSave.getSourceFixAllESLint(setting.value);
			} else {
				result = !!CodeActionsOnSave.getSourceFixAll(setting.value);
			}
			/* For now we don't rewrite the settings to allow users to go back to an older version
			elem.value = undefined;
			elem.changed = true;
			*/
			return result;
		}

		return [
			record(this.autoFixOnSave.global, this.codeActionOnSave.global),
			record(this.autoFixOnSave.workspace, this.codeActionOnSave.workspace),
			record(this.autoFixOnSave.workspaceFolder, this.codeActionOnSave.workspaceFolder)
		];
	}

	private recordValidate(fixAll: [boolean, boolean, boolean]): void {
		function record(this: void, elem: MigrationElement<(ValidateItem | string)[]>, settingAccessor: (language: string) => MigrationElement<CodeActionsOnSave>, fixAll: boolean): void {
			if (elem.value === undefined) {
				return;
			}
			for (let i = 0; i < elem.value.length; i++) {
				const item = elem.value[i];
				if (typeof item === 'string') {
					continue;
				}
				if (fixAll && item.autoFix === false && typeof item.language === 'string') {
					const setting = settingAccessor(item.language);
					if (!Is.objectLiteral(setting.value) && !Array.isArray(setting.value)) {
						setting.value = Object.create(null) as {};
					}
					if (CodeActionsOnSave.getSourceFixAllESLint(setting.value!) !== false) {
						CodeActionsOnSave.setSourceFixAllESLint(setting.value!, false);
						setting.changed = true;
					}
				}
				/* For now we don't rewrite the settings to allow users to go back to an older version
				if (item.language !== undefined) {
					elem.value[i] = item.language;
					elem.changed = true;
				}
				*/
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

		record(this.validate.global, (language) => getCodeActionsOnSave(language).global, fixAll[0]);
		record(this.validate.workspace, (language) => getCodeActionsOnSave(language).workspace, fixAll[1] ? fixAll[1] : fixAll[0]);
		record(this.validate.workspaceFolder, (language) => getCodeActionsOnSave(language).workspaceFolder, fixAll[2] ? fixAll[2] : (fixAll[1] ? fixAll[1] : fixAll[0]));
	}

	private recordWorkingDirectories(): void {
		function record(this: void, elem: MigrationElement<(string | DirectoryItem | LegacyDirectoryItem | PatternItem | ModeItem)[]>): void {
			if (elem.value === undefined || !Array.isArray(elem.value)) {
				return;
			}
			for (let i = 0; i < elem.value.length; i++) {
				const item = elem.value[i];
				if (typeof item === 'string' || ModeItem.is(item) || PatternItem.is(item)) {
					continue;
				}
				if (DirectoryItem.is(item) && item['!cwd'] !== undefined) {
					continue;
				}
				/* For now we don't rewrite the settings to allow users to go back to an older version
				if (LegacyDirectoryItem.is(item)) {
					const legacy: LegacyDirectoryItem = item;
					if (legacy.changeProcessCWD === false) {
						(item as DirectoryItem)['!cwd'] = true;
						elem.changed = true;
					}
				}
				if (DirectoryItem.is(item) && item['!cwd'] === undefined) {
					elem.value[i] = item.directory;
					elem.changed = true;
				}
				*/
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

	const running = 'ESLint server is running.';
	const stopped = 'ESLint server stopped.';
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
		let icon: string| undefined;
		let tooltip: string | undefined;
		if (serverRunning === false) {
			icon = '$(alert)';
		} else {
			switch (status) {
				case Status.ok:
					icon = eslintAlwaysAllowLibraryState ? '$(globe)' : '$(check)';
					break;
				case Status.warn:
					icon = '$(alert)';
					break;
				case Status.error:
					icon = '$(issue-opened)';
					break;
				case Status.notConfirmed:
					icon = '$(circle-slash)';
					tooltip = 'ESLint execution not trused.';
					break;
				default:
					icon = eslintAlwaysAllowLibraryState ? '$(globe)' : '$(check)';
			}
		}
		statusBarItem.text = icon ? `${icon} ESLint` : 'ESLint';
		statusBarItem.tooltip = tooltip ? tooltip : serverRunning ? running : stopped;
		updateStatusBarVisibility();
	}

	function updateStatusBarVisibility(): void {
		showStatusBarItem(
			serverRunning || Workspace.getConfiguration('eslint').get('alwaysShowStatus', false)
		);
	}

	function readCodeActionsOnSaveSetting(document: TextDocument): boolean {
		let result: boolean | undefined = undefined;
		const languageConfig = Workspace.getConfiguration(undefined, document.uri).get<LanguageSettings>(`[${document.languageId}]`);

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

		if (languageConfig !== undefined) {
			const codeActionsOnSave = languageConfig?.['editor.codeActionsOnSave'];
			if (codeActionsOnSave !== undefined) {
				result = isEnabled(codeActionsOnSave);
			}
		}
		if (result === undefined) {
			const codeActionsOnSave = Workspace.getConfiguration('editor', document.uri).get<CodeActionsOnSave>('codeActionsOnSave');
			if (codeActionsOnSave !== undefined) {
				result = isEnabled(codeActionsOnSave);
			}
		}
		return result ?? false;
	}

	function migrationFailed(error: any): void {
		client.error(error.message ?? 'Unknown error', error);
		Window.showErrorMessage('ESLint settings migration failed. Please see the ESLint output channel for further details', 'Open Channel').then((selected) => {
			if (selected === undefined) {
				return;
			}
			client.outputChannel.show();
		});

	}

	async function migrateSettings(): Promise<void> {
		const folders = Workspace.workspaceFolders;
		if (folders === undefined) {
			Window.showErrorMessage('ESLint settings can only be converted if VS Code is opened on a workspace folder.');
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

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	// serverModule
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'eslintServer.js'));
	const eslintConfig = Workspace.getConfiguration('eslint');
	const runtime = eslintConfig.get('runtime', undefined);
	const debug = eslintConfig.get('debug');
	const nodeEnv = eslintConfig.get('nodeEnv', null);

	let env: { [key: string]: string | number | boolean } | undefined;
	if (debug) {
		env = env || {};
		env.DEBUG = 'eslint:*,-eslint:code-path';
	}
	if (nodeEnv) {
		env = env || {};
		env.NODE_ENV = nodeEnv;
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

	let migration: Migration | undefined;
	const migrationSemaphore: Semaphore<void> = new Semaphore<void>(1);
	const confirmationSemaphore: Semaphore<boolean> = new Semaphore<boolean>(1);
	let notNow: boolean = false;
	const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source.value, CodeActionKind.SourceFixAll.value, `${CodeActionKind.SourceFixAll.value}.eslint`, CodeActionKind.QuickFix.value]);
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
				if (context.only !== undefined && !supportedQuickFixKinds.has(context.only.value)) {
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
					const result: (ConfigurationSettings | null)[] = [];
					for (const item of params.items) {
						if (item.section || !item.scopeUri) {
							result.push(null);
							continue;
						}
						const resource = client.protocol2CodeConverter.asUri(item.scopeUri);
						const config = Workspace.getConfiguration('eslint', resource);
						const workspaceFolder = Workspace.getWorkspaceFolder(resource);
						await migrationSemaphore.lock(async () => {
							const globalMigration = Workspace.getConfiguration('eslint').get('migration.2_x', 'on');
							if (notNow === false && globalMigration === 'on'  /*&& !(workspaceFolder !== undefined ? noMigrationLocal!.workspaces[workspaceFolder.uri.toString()] : noMigrationLocal!.files[resource.toString()]) */) {
								try {
									migration = new Migration(resource);
									migration.record();
									interface Item extends MessageItem {
										id: 'yes' | 'no' | 'readme' | 'global' | 'local';
									}
									if (migration.needsUpdate()) {
										const folder = workspaceFolder?.name;
										const file = path.basename(resource.fsPath);
										const selected = await Window.showInformationMessage<Item>(
											[
												`The ESLint 'autoFixOnSave' setting needs to be migrated to the new 'editor.codeActionsOnSave' setting`,
												folder !== undefined ? `for the workspace folder: ${folder}.` : `for the file: ${file}.`,
												`For compatibility reasons the 'autoFixOnSave' remains and needs to be removed manually.`,
												`Do you want to migrate the setting?`
											].join(' '),
											{ modal: true},
											{ id: 'yes', title: 'Yes'},
											{ id: 'global', title: 'Never migrate Settings' },
											{ id: 'readme', title: 'Open Readme' },
											{ id: 'no', title: 'Not now', isCloseAffordance: true }
										);
										if (selected !== undefined) {
											if (selected.id === 'yes') {
												try {
													await migration.update();
												} catch (error) {
													migrationFailed(error);
												}
											} else if (selected.id === 'no') {
												notNow = true;
											} else if (selected.id === 'global') {
												await config.update('migration.2_x', 'off', ConfigurationTarget.Global);
											} else if (selected.id === 'readme') {
												notNow = true;
												Env.openExternal(Uri.parse('https://github.com/microsoft/vscode-eslint#settings-migration'));
											}
										}
									}
								} finally {
									migration = undefined;
								}
							}
						});
						const settings: ConfigurationSettings = {
							validate: Validate.off,
							packageManager: config.get('packageManager', 'npm'),
							codeActionOnSave: {
								enable: false,
								mode: CodeActionsOnSaveMode.all
							},
							format: false,
							quiet: config.get('quiet', false),
							onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
							options: config.get('options', {}),
							run: config.get('run', 'onType'),
							nodePath: config.get('nodePath', null),
							workingDirectory: undefined,
							workspaceFolder: undefined,
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
							settings.codeActionOnSave.enable = readCodeActionsOnSaveSetting(document);
							settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(config.get('codeActionsOnSave.mode', CodeActionsOnSaveMode.all));
						}
						if (workspaceFolder !== undefined) {
							settings.workspaceFolder = {
								name: workspaceFolder.name,
								uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
							};
						}
						const workingDirectories = config.get<(string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined>('workingDirectories', undefined);
						if (Array.isArray(workingDirectories)) {
							let workingDirectory: ModeItem | DirectoryItem | undefined = undefined;
							const workspaceFolderPath = workspaceFolder && workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
							for (const entry of workingDirectories) {
								let directory: string | undefined;
								let pattern: string | undefined;
								let noCWD = false;
								if (Is.string(entry)) {
									directory = entry;
								} else if (LegacyDirectoryItem.is(entry)) {
									directory = entry.directory;
									noCWD = !entry.changeProcessCWD;
								} else if (DirectoryItem.is(entry)) {
									directory = entry.directory;
									if (entry['!cwd'] !== undefined) {
										noCWD = entry['!cwd'];
									}
								} else if (PatternItem.is(entry)) {
									pattern = entry.pattern;
									if (entry['!cwd'] !== undefined) {
										noCWD = entry['!cwd'];
									}
								} else if (ModeItem.is(entry)) {
									workingDirectory = entry;
									continue;
								}

								let itemValue: string | undefined;
								if (directory !== undefined || pattern !== undefined) {
									const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
									if (filePath !== undefined) {
										if (directory !== undefined) {
											directory = toOSPath(directory);
											if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
												directory = path.join(workspaceFolderPath, directory);
											}
											if (directory.charAt(directory.length - 1) !== path.sep) {
												directory = directory + path.sep;
											}
											if (filePath.startsWith(directory)) {
												itemValue = directory;
											}
										} else if (pattern !== undefined && pattern.length > 0) {
											if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
												pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern);
											}
											if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
												pattern = pattern + path.posix.sep;
											}
											const regExp: RegExp | undefined = convert2RegExp(pattern);
											if (regExp !== undefined) {
												const match = regExp.exec(filePath);
												if (match !== null && match.length > 0) {
													itemValue = match[0];
												}
											}
										}
									}
								}
								if (itemValue !== undefined) {
									if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
										workingDirectory = { directory: itemValue, '!cwd': noCWD };
									} else {
										if (workingDirectory.directory.length < itemValue.length) {
											workingDirectory.directory = itemValue;
											workingDirectory['!cwd'] = noCWD;
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

	Workspace.onDidChangeConfiguration(() => {
		probeFailed.clear();
		for (const textDocument of syncedDocuments.values()) {
			if (computeValidate(textDocument) === Validate.off) {
				try {
					const provider = client.getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
					provider.send(textDocument);
				} catch (err) {
					// A feature currently throws if no provider can be found. So for now we catch the exception.
				}
			}
		}
		for (const textDocument of Workspace.textDocuments) {
			if (!syncedDocuments.has(textDocument.uri.toString()) && computeValidate(textDocument) !== Validate.off) {
				try {
					const provider = client.getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
					provider.send(textDocument);
				} catch (err) {
					// A feature currently throws if no provider can be found. So for now we catch the exception.
				}
			}
		}
	});

	defaultErrorHandler = client.createDefaultErrorHandler();
	client.onDidChangeState((event) => {
		if (event.newState === ClientState.Running) {
			client.info(running);
			serverRunning = true;
		} else {
			client.info(stopped);
			serverRunning = false;
		}
		updateStatus(eslintStatus);
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

		client.onRequest(ProbeFailedRequest.type, (params) => {
			probeFailed.add(params.textDocument.uri);
			const closeFeature = client.getFeature(DidCloseTextDocumentNotification.method);
			for (const document of Workspace.textDocuments) {
				if (document.uri.toString() === params.textDocument.uri) {
					closeFeature.getProvider(document).send(document);
				}
			}
		});

		client.onRequest(ConfirmESLintLibrary.type, async (params): Promise<boolean> => {
			return confirmationSemaphore.lock(async () => {
				try {
					sessionState.set(params.libraryPath, params);
					if (eslintAlwaysAllowLibraryState === true) {
						clearDiagnosticState(params);
						return true;
					}
					const state = eslintLibraryState.libs[params.libraryPath];
					if (state === true || state === false) {
						clearDiagnosticState(params);
						return state;
					}
					const canceled = canceledLibraries.get(params.libraryPath);
					if (canceled === false) {
						checkDiagnosticState(params, Window.activeTextEditor);
						return false;
					}

					pendingUris2LibraryParams.set(params.uri, params);
					let info: PendingLibraryInfo | undefined = libraryPath2PendingLibraryInfo.get(params.libraryPath);
					if (info === undefined) {
						info = {
							params: params,
							pendingUris: new Set(),
							diagnostics: Languages.createDiagnosticCollection(),
							editorErrorUri: undefined,
							codeActionProvider: undefined,
							libErrorUri: undefined,
							libCodeActionProvider: undefined
						};
						libraryPath2PendingLibraryInfo.set(params.libraryPath, info);
					}
					info.pendingUris.add(params.uri);
					checkDiagnosticState(params, Window.activeTextEditor);
					return false;
				} catch (err) {
					return false;
				}
			});
		});
	});

	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
		onActivateCommands = undefined;
	}

	updateStatusBarVisibility();

	context.subscriptions.push(
		client.start(),
		Window.onDidChangeActiveTextEditor((editor) => {
			checkDiagnosticState(undefined, editor);
		}),
		Workspace.registerTextDocumentContentProvider('eslint-error', {
			provideTextDocumentContent: () => {
				return [
					'ESLint is disabled since its execution has not been approved or rejected yet.',
					'',
					'When validating a file using ESLint, the ESLint NPM library will load customization files and code from your workspace',
					'and will exexute it. If you do not trust the content in your workspace you should answer accordingly on the corresponding',
					'approval dialog.'
				].join('\n');
			}
		}),
		Workspace.onDidOpenTextDocument((document) => {
			if (document.uri.scheme === 'eslint-error') {
				const libraryPath = libraryPathMapping.get(document.uri.fsPath);
				if (libraryPath === undefined) {
					return;
				}
				const pendingLibraryInfo = libraryPath2PendingLibraryInfo.get(libraryPath);
				if (pendingLibraryInfo !== undefined) {
					askForLibraryConfirmation(client, context, pendingLibraryInfo.params, true, updateStatus);
				}
			}
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
			await client.onReady();
			client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
				Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
			});
		}),
		Commands.registerCommand('eslint.showOutputChannel', async () => {
			if (eslintStatus === Status.notConfirmed) {
				let candidate: string | undefined;
				let toRemove: Set<string> | Map<string, boolean> | undefined;
				if (libraryPath2PendingLibraryInfo.size === 1) {
					candidate = libraryPath2PendingLibraryInfo.keys().next().value;
				} else if (canceledLibraries.size === 1) {
					candidate = canceledLibraries.keys().next().value;
					toRemove = canceledLibraries;
				}
				if (candidate !== undefined) {
					if (sessionState.has(candidate)) {
						if (toRemove !== undefined) {
							toRemove.delete(candidate);
						}
						askForLibraryConfirmation(client, context, sessionState.get(candidate)!, true, updateStatus);
					} else {
						manageLibraryConfirmations(client, context);
					}
				} else {
					manageLibraryConfirmations(client, context);
				}
			} else {
				client.outputChannel.show();
			}
		}),
		Commands.registerCommand('eslint.migrateSettings', () => {
			migrateSettings();
		}),
		Commands.registerCommand('eslint.manageLibraryConfirmations', () => {
			manageLibraryConfirmations(client, context);
		}),
		Commands.registerCommand('eslint.confirmExecution', (params: ConfirmESLintLibraryParams) => {
			canceledLibraries.delete(params.libraryPath);
			askForLibraryConfirmation(client, context, params, true, updateStatus);
		})
	);
}

export function deactivate() {
	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
	}

	if (taskProvider) {
		taskProvider.dispose();
	}
}
