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
	WorkspaceFolder as VWorkspaceFolder, CodeAction, MessageItem, ConfigurationTarget, env as Env, CodeActionKind,
	WorkspaceConfiguration, ThemeColor
} from 'vscode';
import {
	LanguageClient, LanguageClientOptions, RequestType, TransportKind, TextDocumentIdentifier, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, State as ClientState, RevealOutputChannelOn, VersionedTextDocumentIdentifier, ExecuteCommandRequest,
	ExecuteCommandParams, ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
	WorkspaceFolder, NotificationType0
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
	export function from(value: string | undefined | null): CodeActionsOnSaveMode {
		if (value === undefined || value === null) {
			return CodeActionsOnSaveMode.all;
		}
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
	export function from(value: string | undefined | null): ESLintSeverity {
		if (value === undefined || value === null) {
			return ESLintSeverity.off;
		}
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

enum RuleSeverity {
	// Original ESLint values
	info = 'info',
	warn = 'warn',
	error = 'error',
	off = 'off',

	// Added severity override changes
	default = 'default',
	downgrade = 'downgrade',
	upgrade = 'upgrade'
}

type NpmPackageManager = 'npm' | 'pnpm' | 'yarn';

interface RuleCustomization  {
	rule: string;
	severity: RuleSeverity;
}

interface ConfigurationSettings {
	validate: Validate;
	packageManager: NpmPackageManager;
	codeAction: CodeActionSettings;
	codeActionOnSave: CodeActionsOnSaveSettings;
	format: boolean;
	quiet: boolean;
	onIgnoredFiles: ESLintSeverity;
	options: any | undefined;
	rulesCustomizations: RuleCustomization[];
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
	error = 3
}

interface StatusParams {
	uri: string;
	state: Status;
}

namespace StatusNotification {
	export const type = new NotificationType<StatusParams>('eslint/status');
}

interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type = new RequestType<NoConfigParams, NoConfigResult, void>('eslint/noConfig');
}


interface NoESLintLibraryParams {
	source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {
}

namespace NoESLintLibraryRequest {
	export const type = new RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void>('eslint/noLibrary');
}

interface OpenESLintDocParams {
	url: string;
}

interface OpenESLintDocResult {

}

namespace OpenESLintDocRequest {
	export const type = new RequestType<OpenESLintDocParams, OpenESLintDocResult, void>('eslint/openDoc');
}

interface ProbeFailedParams {
	textDocument: TextDocumentIdentifier;
}

namespace ProbeFailedRequest {
	export const type = new RequestType<ProbeFailedParams, void, void>('eslint/probeFailed');
}

namespace ShowOutputChannel {
	export const type = new NotificationType0('eslint/showOutputChannel');
}

const exitCalled = new NotificationType<[number, string]>('eslint/exitCalled');

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

let taskProvider: TaskProvider;

// Copied from LSP libraries. We should have a flag in the client to know whether the
// client runs in debugger mode.
function isInDebugMode(): boolean {
	const debugStartWith: string[] = ['--debug=', '--debug-brk=', '--inspect=', '--inspect-brk='];
	const debugEquals: string[] = ['--debug', '--debug-brk', '--inspect', '--inspect-brk'];
	let args: string[] = (process as any).execArgv;
	if (args) {
		return args.some((arg) => {
			return debugStartWith.some(value => arg.startsWith(value)) ||
					debugEquals.some(value => arg === value);
		});
	}
	return false;
}

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
		switch (status) {
			case Status.ok:
				icon = undefined;
				break;
			case Status.warn:
				icon = '$(alert)';
				break;
			case Status.error:
				icon = '$(issue-opened)';
				break;
		}
		statusBarItem.text = icon !== undefined ? `${icon} ${text}` : text;
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

	const serverModule = Uri.joinPath(context.extensionUri, 'server', 'out', 'eslintServer.js').fsPath;
	const eslintConfig = Workspace.getConfiguration('eslint');
	const debug = eslintConfig.get<boolean>('debug', false) ?? false;
	const runtime = eslintConfig.get<string | undefined>('runtime', undefined) ?? undefined;

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
				const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics });
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
												void Env.openExternal(Uri.parse('https://github.com/microsoft/vscode-eslint#settings-migration'));
											}
										}
									}
								} finally {
									migration = undefined;
								}
							}
						});

						let packageManager: NpmPackageManager | null | undefined;
						packageManager = config.get('packageManager');
						if (!packageManager) {
							try {
								packageManager = await Commands.executeCommand<NpmPackageManager>('npm.packageManager', workspaceFolder?.uri);
							} catch {
								// ignore
							}
						}

						const settings: ConfigurationSettings = {
							validate: Validate.off,
							packageManager: !!packageManager ? packageManager : 'npm',
							codeActionOnSave: {
								enable: false,
								mode: CodeActionsOnSaveMode.all
							},
							format: false,
							quiet: config.get('quiet', false),
							onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
							options: config.get('options', {}),
							rulesCustomizations: parseRulesCustomizations(config.get('rules.customizations')),
							run: config.get('run', 'onType'),
							nodePath: config.get<string | undefined>('nodePath', undefined) ?? null,
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
		void Window.showErrorMessage(`The ESLint extension couldn't be started. See the ESLint output channel for details.`);
		return;
	}
	client.registerProposedFeatures();

	Workspace.onDidChangeConfiguration(() => {
		probeFailed.clear();
		for (const textDocument of syncedDocuments.values()) {
			if (computeValidate(textDocument) === Validate.off) {
				try {
					const provider = client.getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument);
				} catch (err) {
					// A feature currently throws if no provider can be found. So for now we catch the exception.
				}
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

	const readyHandler = () => {
		client.onNotification(ShowOutputChannel.type, () => {
			client.outputChannel.show();
		});

		client.onNotification(StatusNotification.type, (params) => {
			updateDocumentStatus(params);
		});

		client.onNotification(exitCalled, (params) => {
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
			const packageManager = Workspace.getConfiguration('eslint', uri).get<NpmPackageManager>('packageManager', 'npm');
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
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `npm.packageManager` or `eslint.packageManager` to either `yarn` or `pnpm`' : null,
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
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `npm.packageManager` or `eslint.packageManager` to either `yarn` or `pnpm`' : null,
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
	};

	client.onReady().then(readyHandler).catch((error) => client.error(`On ready failed`, error));

	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
		onActivateCommands = undefined;
	}

	context.subscriptions.push(
		client.start(),
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
			await client.onReady();
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
		Commands.registerCommand('eslint.restart', async () => {
			await client.stop();
			// Wait a little to free debugger port. Can not happen in production
			// So we should add a dev flag.
			const start = () => {
				client.start();
				client.onReady().then(readyHandler).catch((error) => client.error(`On ready failed`, error));
			};
			if (isInDebugMode()) {
				setTimeout(start, 1000);
			} else {
				start();
			}
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
