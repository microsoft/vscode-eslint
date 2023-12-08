/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { workspace as Workspace, Uri, WorkspaceConfiguration, ConfigurationTarget } from 'vscode';

import { Is } from './node-utils';
import { DirectoryItem, ModeItem } from './shared/settings';

// Defines settings locally to the client or deprecated settings that are converted to
// shared settings

export type ValidateItem = {
	language: string;
	autoFix?: boolean;
};

export namespace ValidateItem {
	export function is(item: any): item is ValidateItem {
		const candidate = item as ValidateItem;
		return candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0);
	}
}

export type LegacyDirectoryItem = {
	directory: string;
	changeProcessCWD: boolean;
};

export namespace LegacyDirectoryItem {
	export function is(item: any): item is LegacyDirectoryItem {
		const candidate = item as LegacyDirectoryItem;
		return candidate && Is.string(candidate.directory) && Is.boolean(candidate.changeProcessCWD);
	}
}

export type PatternItem = {
	pattern: string;
	'!cwd'?: boolean;
};

export namespace PatternItem {
	export function is(item: any): item is PatternItem {
		const candidate = item as PatternItem;
		return candidate && Is.string(candidate.pattern) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined);
	}
}

// ----- Settings  migration code

type InspectData<T> = {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
};

type MigrationElement<T> = {
	changed: boolean;
	value: T | undefined;
};

type MigrationData<T> = {
	global: MigrationElement<T>;
	workspace: MigrationElement<T>;
	workspaceFolder: MigrationElement<T>;
};

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

type LanguageSettings = {
	'editor.codeActionsOnSave'?: CodeActionsOnSave;
};

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

export class Migration {
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