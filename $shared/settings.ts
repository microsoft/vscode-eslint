/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	WorkspaceFolder
} from 'vscode-languageserver-protocol';

namespace Is {
	const toString = Object.prototype.toString;

	export function boolean(value: any): value is boolean {
		return value === true || value === false;
	}

	export function string(value: any): value is string {
		return toString.call(value) === '[object String]';
	}
}

export enum Validate {
	on = 'on',
	off = 'off',
	probe = 'probe'
}

export type CodeActionSettings = {
	disableRuleComment: {
		enable: boolean;
		location: 'separateLine' | 'sameLine';
		commentStyle: 'line' | 'block';
	};
	showDocumentation: {
		enable: boolean;
	};
};

export enum CodeActionsOnSaveMode {
	all = 'all',
	problems = 'problems'
}

export namespace CodeActionsOnSaveMode {
	export function from(value: string | undefined | null): CodeActionsOnSaveMode {
		if (value === undefined || value === null || !Is.string(value)) {
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

export namespace CodeActionsOnSaveRules {
	export function from(value: string[] | undefined | null): string[] | undefined {
		if (value === undefined || value === null || !Array.isArray(value)) {
			return undefined;
		}
		return value.filter(item => Is.string(item));
	}
}

export namespace CodeActionsOnSaveOptions {
	export function from(value: object | undefined | null): ESLintOptions | undefined {
		if (value === undefined || value === null || typeof value !== 'object') {
			return undefined;
		}
		return value;
	}
}

export type CodeActionsOnSaveSettings = {
	mode: CodeActionsOnSaveMode;
	rules?: string[];
	options?: ESLintOptions;
};

export enum ESLintSeverity {
	off = 'off',
	warn = 'warn',
	error = 'error'
}

export namespace ESLintSeverity {
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

export enum RuleSeverity {
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

export type RuleCustomization = {
	rule: string;
	severity: RuleSeverity;
	/** Only apply to autofixable rules */
	fixable?: boolean;
};

export type RunValues = 'onType' | 'onSave';

export enum ModeEnum {
	auto = 'auto',
	location = 'location'
}

export namespace ModeEnum {
	export function is(value: string): value is ModeEnum {
		return value === ModeEnum.auto || value === ModeEnum.location;
	}
}

export type ModeItem = {
	mode: ModeEnum;
};

export namespace ModeItem {
	export function is(item: any): item is ModeItem {
		const candidate = item as ModeItem;
		return candidate && ModeEnum.is(candidate.mode);
	}
}

export type DirectoryItem = {
	directory: string;
	'!cwd'?: boolean;
};

export namespace DirectoryItem {
	export function is(item: any): item is DirectoryItem {
		const candidate = item as DirectoryItem;
		return candidate && Is.string(candidate.directory) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined);
	}
}

export type PackageManagers = 'npm' | 'yarn' | 'pnpm';

export type ESLintOptions = object & { fixTypes?: string[] };

export type ConfigurationSettings = {
	validate: Validate;
	packageManager: PackageManagers;
	useESLintClass: boolean;
	useFlatConfig?: boolean | undefined;
	experimental?: {
		useFlatConfig: boolean;
	};
	codeAction: CodeActionSettings;
	codeActionOnSave: CodeActionsOnSaveSettings;
	format: boolean;
	quiet: boolean;
	onIgnoredFiles: ESLintSeverity;
	options: ESLintOptions | undefined;
	rulesCustomizations: RuleCustomization[];
	run: RunValues;
	problems: {
		shortenToSingleLine: boolean;
	};
	nodePath: string | null;
	workspaceFolder: WorkspaceFolder | undefined;
	workingDirectory: ModeItem | DirectoryItem | undefined;
};
