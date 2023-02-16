/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	Diagnostic, DiagnosticSeverity, DiagnosticTag, ProposedFeatures, Range, TextEdit, Files, DocumentFilter, DocumentFormattingRegistrationOptions,
	Disposable, DocumentFormattingRequest, TextDocuments, uinteger
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { ProbeFailedParams, ProbeFailedRequest, NoESLintLibraryRequest, Status, NoConfigRequest } from './shared/customMessages';
import { ConfigurationSettings, DirectoryItem, ESLintSeverity, ModeEnum, ModeItem, PackageManagers, RuleCustomization, RuleSeverity, Validate } from './shared/settings';

import * as Is from './is';
import { LRUCache } from './linkedMap';
import { isUNC, normalizeDriveLetter, normalizePath } from './paths';
import LanguageDefaults from './languageDefaults';


/**
 * ESLint specific settings for a text document.
 */
export type TextDocumentSettings = Omit<ConfigurationSettings, 'workingDirectory'>  & {
	silent: boolean;
	workingDirectory: DirectoryItem | undefined;
	library: ESLintModule | undefined;
	resolvedGlobalPackageManagerPath: string | undefined;
};

export namespace TextDocumentSettings {
	export function hasLibrary(settings: TextDocumentSettings): settings is (TextDocumentSettings & { library: ESLintModule }) {
		return settings.library !== undefined;
	}
}

/**
 * A special error thrown by the ESLint library
 */
export interface ESLintError extends Error {
	messageTemplate?: string;
	messageData?: {
		pluginName?: string;
	};
}

export namespace ESLintError {
	export function isNoConfigFound(error: any): boolean {
		const candidate = error as ESLintError;
		return candidate.messageTemplate === 'no-config-found' || candidate.message === 'No ESLint configuration found.';
	}
}

type ESLintAutoFixEdit = {
	range: [number, number];
	text: string;
};

type ESLintSuggestionResult = {
	desc: string;
	fix: ESLintAutoFixEdit;
};

type ESLintProblem = {
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutoFixEdit;
	suggestions?: ESLintSuggestionResult[]
};

type ESLintDocumentReport = {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
	output?: string;
};

type ESLintReport = {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
};

export type CLIOptions = {
	cwd?: string;
	fixTypes?: string[];
	fix?: boolean;
};

export type SeverityConf = 0 | 1 | 2 | 'off' | 'warn' | 'error';

export type RuleConf = SeverityConf | [SeverityConf, ...any[]];

export type ConfigData = {
	rules?: Record<string, RuleConf>;
};

export type ESLintClassOptions = {
	cwd?: string;
	fixTypes?: string[];
	fix?: boolean;
	overrideConfig?: ConfigData;
	overrideConfigFile?: string | null;
};

export type RuleMetaData = {
	docs?: {
		url?: string;
	};
	type?: string;
};

export namespace RuleMetaData {
	// For unused eslint-disable comments, ESLint does not include a rule ID
	// nor any other metadata (although they do provide a fix). In order to
	// provide code actions for these, we create a fake rule ID and metadata.
	export const unusedDisableDirectiveId = 'unused-disable-directive';
	const unusedDisableDirectiveMeta: RuleMetaData = {
		docs: {
			url: 'https://eslint.org/docs/latest/use/configure/rules#report-unused-eslint-disable-comments'
		},
		type: 'directive'
	};

	const handled: Set<string> = new Set();
	const ruleId2Meta: Map<string, RuleMetaData> = new Map([[unusedDisableDirectiveId, unusedDisableDirectiveMeta]]);

	export function capture(eslint: ESLintClass, reports: ESLintDocumentReport[]): void {
		let rulesMetaData: Record<string, RuleMetaData> | undefined;
		if (eslint.isCLIEngine) {
			const toHandle = reports.filter(report => !handled.has(report.filePath));
			if (toHandle.length === 0) {
				return;
			}
			rulesMetaData = typeof eslint.getRulesMetaForResults === 'function' ? eslint.getRulesMetaForResults(toHandle) : undefined;
			toHandle.forEach(report => handled.add(report.filePath));
		} else {
			rulesMetaData = typeof eslint.getRulesMetaForResults === 'function' ? eslint.getRulesMetaForResults(reports) : undefined;
		}
		if (rulesMetaData === undefined) {
			return undefined;
		}
		Object.entries(rulesMetaData).forEach(([key, meta]) => {
			if (ruleId2Meta.has(key)) {
				return;
			}
			if (meta && meta.docs && Is.string(meta.docs.url)) {
				ruleId2Meta.set(key, meta);
			}
		});
	}

	export function clear(): void {
		handled.clear();
		ruleId2Meta.clear();
		ruleId2Meta.set(unusedDisableDirectiveId, unusedDisableDirectiveMeta);
	}

	export function getUrl(ruleId: string): string | undefined {
		return ruleId2Meta.get(ruleId)?.docs?.url;
	}

	export function getType(ruleId: string): string | undefined {
		return ruleId2Meta.get(ruleId)?.type;
	}

	export function hasRuleId(ruleId: string): boolean {
		return ruleId2Meta.has(ruleId);
	}

	export function isUnusedDisableDirectiveProblem(problem: ESLintProblem): boolean {
		return problem.ruleId === null && problem.message.startsWith('Unused eslint-disable directive');
	}
}

export type ParserOptions = {
	parser?: string;
};

export type ESLintConfig = {
 	env: Record<string, boolean>;
	extends:  string | string[];
 	// globals: Record<string, GlobalConf>;
 	ignorePatterns: string | string[];
 	noInlineConfig: boolean;
 	// overrides: OverrideConfigData[];
 	parser: string | null;
 	parserOptions?: ParserOptions;
 	plugins: string[];
 	processor: string;
 	reportUnusedDisableDirectives: boolean | undefined;
 	root: boolean;
 	rules: Record<string, RuleConf>;
 	settings: object;
};

export type Problem = {
	label: string;
	documentVersion: number;
	ruleId: string;
	line: number;
	diagnostic: Diagnostic;
	edit?: ESLintAutoFixEdit;
	suggestions?: ESLintSuggestionResult[];
};

export namespace Problem {
	export function isFixable(problem: Problem): problem is FixableProblem {
		return problem.edit !== undefined;
	}

	export function hasSuggestions(problem: Problem): problem is SuggestionsProblem {
		return problem.suggestions !== undefined;
	}
}

export type FixableProblem = Problem & {
	edit: ESLintAutoFixEdit;
};

export namespace FixableProblem {
	export function createTextEdit(document: TextDocument, editInfo: FixableProblem): TextEdit {
		return TextEdit.replace(Range.create(document.positionAt(editInfo.edit.range[0]), document.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}
}

export type SuggestionsProblem = Problem & {
	suggestions: ESLintSuggestionResult[];
};

export namespace SuggestionsProblem {
	export function createTextEdit(document: TextDocument, suggestion: ESLintSuggestionResult): TextEdit {
		return TextEdit.replace(Range.create(document.positionAt(suggestion.fix.range[0]), document.positionAt(suggestion.fix.range[1])), suggestion.fix.text || '');
	}
}

interface ESLintClass {
	// https://eslint.org/docs/developer-guide/nodejs-api#-eslintlinttextcode-options
	lintText(content: string, options: {filePath?: string, warnIgnored?: boolean}): Promise<ESLintDocumentReport[]>;
	// https://eslint.org/docs/developer-guide/nodejs-api#-eslintispathignoredfilepath
	isPathIgnored(path: string): Promise<boolean>;
	// https://eslint.org/docs/developer-guide/nodejs-api#-eslintgetrulesmetaforresultsresults
	getRulesMetaForResults?(results: ESLintDocumentReport[]): Record<string, RuleMetaData> | undefined /* for ESLintClassEmulator */;
	// https://eslint.org/docs/developer-guide/nodejs-api#-eslintcalculateconfigforfilefilepath
	calculateConfigForFile(path: string): Promise<ESLintConfig | undefined /* for ESLintClassEmulator */>;
	// Whether it is the old CLI Engine
	isCLIEngine?: boolean;
}

interface ESLintClassConstructor {
	new(options: ESLintClassOptions): ESLintClass;
}

interface CLIEngineConstructor {
	new(options: CLIOptions): CLIEngine;
}

/**
 * A loaded ESLint npm module.
 */
export type ESLintModule =
{
	// version < 7.0
	ESLint: undefined;
	CLIEngine: CLIEngineConstructor;
} | {
	// 7.0 <= version < 8.0
	ESLint: ESLintClassConstructor;
	CLIEngine: CLIEngineConstructor;
} | {
	// 8.0 <= version.
	ESLint: ESLintClassConstructor;
	isFlatConfig?: boolean;
	CLIEngine: undefined;
};

export namespace ESLintModule {
	export function hasESLintClass(value: ESLintModule): value is { ESLint: ESLintClassConstructor; CLIEngine: undefined; } {
		return value.ESLint !== undefined;
	}
	export function hasCLIEngine(value: ESLintModule): value is { ESLint: undefined; CLIEngine: CLIEngineConstructor; } {
		return value.CLIEngine !== undefined;
	}
	export function isFlatConfig(value: ESLintModule): value is { ESLint: ESLintClassConstructor; CLIEngine: undefined; isFlatConfig: true } {
		const candidate: { ESLint: ESLintClassConstructor; isFlatConfig?: boolean } = value as any;
		return candidate.ESLint !== undefined && candidate.isFlatConfig === true;
	}
}

// { meta: { docs: [Object], schema: [Array] }, create: [Function: create] }
type RuleData = {
	meta?: RuleMetaData;
};

namespace RuleData {
	export function hasMetaType(value: RuleMetaData | undefined): value is RuleMetaData & { type: string; } {
		return value !== undefined && value.type !== undefined;
	}
}

interface CLIEngine {
	executeOnText(content: string, file?: string, warn?: boolean): ESLintReport;
	isPathIgnored(path: string): boolean;
	// This is only available from v4.15.0 forward
	getRules?(): Map<string, RuleData>;
	getConfigForFile?(path: string): ESLintConfig;
}

namespace CLIEngine {
	export function hasRule(value: CLIEngine): value is CLIEngine & { getRules(): Map<string, RuleData> } {
		return value.getRules !== undefined;
	}
}

/**
 * ESLint class emulator using CLI Engine.
 */
class ESLintClassEmulator implements ESLintClass {

	private cli: CLIEngine;

	constructor(cli: CLIEngine) {
		this.cli = cli;
	}
	get isCLIEngine(): boolean {
		return true;
	}
	async lintText(content: string, options: { filePath?: string | undefined; warnIgnored?: boolean | undefined; }): Promise<ESLintDocumentReport[]> {
		return this.cli.executeOnText(content, options.filePath, options.warnIgnored).results;
	}
	async isPathIgnored(path: string): Promise<boolean> {
		return this.cli.isPathIgnored(path);
	}
	getRulesMetaForResults(_results: ESLintDocumentReport[]): Record<string, RuleMetaData> | undefined {
		if (!CLIEngine.hasRule(this.cli)) {
			return undefined;
		}
		const rules: Record<string, RuleMetaData> = {};
		for (const [name, rule] of this.cli.getRules()) {
			if (rule.meta !== undefined) {
				rules[name] = rule.meta;
			}
		}
		return rules;
	}
	async calculateConfigForFile(path: string): Promise<ESLintConfig | undefined> {
		return typeof this.cli.getConfigForFile === 'function' ? this.cli.getConfigForFile(path) : undefined;
	}
}


/**
 * Class for dealing with Fixes.
 */
export class Fixes {
	constructor(private edits: Map<string, Problem>) {
	}

	public static overlaps(a: FixableProblem | undefined, b: FixableProblem): boolean {
		return a !== undefined && a.edit.range[1] > b.edit.range[0];
	}

	public static sameRange(a: FixableProblem, b: FixableProblem): boolean {
		return a.edit.range[0] === b.edit.range[0] && a.edit.range[1] === b.edit.range[1];
	}

	public isEmpty(): boolean {
		return this.edits.size === 0;
	}

	public getDocumentVersion(): number {
		if (this.isEmpty()) {
			throw new Error('No edits recorded.');
		}
		return this.edits.values().next().value.documentVersion;
	}

	public getScoped(diagnostics: Diagnostic[]): Problem[] {
		const result: Problem[] = [];
		for (const diagnostic of diagnostics) {
			const key = Diagnostics.computeKey(diagnostic);
			const editInfo = this.edits.get(key);
			if (editInfo) {
				result.push(editInfo);
			}
		}
		return result;
	}

	public getAllSorted(): FixableProblem[] {
		const result: FixableProblem[] = [];
		for (const value of this.edits.values()) {
			if (Problem.isFixable(value)) {
				result.push(value);
			}
		}
		return result.sort((a, b) => {
			const d0 = a.edit.range[0] - b.edit.range[0];
			if (d0 !== 0) {
				return d0;
			}
			// Both edits have now the same start offset.

			// Length of a and length of b
			const al = a.edit.range[1] - a.edit.range[0];
			const bl = b.edit.range[1] - b.edit.range[0];
			// Both has the same start offset and length.
			if (al === bl) {
				return 0;
			}

			if (al === 0) {
				return -1;
			}
			if (bl === 0) {
				return 1;
			}
			return al - bl;
		});
	}

	public getApplicable(): FixableProblem[] {
		const sorted = this.getAllSorted();
		if (sorted.length <= 1) {
			return sorted;
		}
		const result: FixableProblem[] = [];
		let last: FixableProblem = sorted[0];
		result.push(last);
		for (let i = 1; i < sorted.length; i++) {
			let current = sorted[i];
			if (!Fixes.overlaps(last, current) && !Fixes.sameRange(last, current)) {
				result.push(current);
				last = current;
			}
		}
		return result;
	}
}

export type SaveRuleConfigItem = { offRules: Set<string>, onRules: Set<string>};

/**
 * Manages the special save rule configurations done in the VS Code settings.
 */
export namespace SaveRuleConfigs {

	export let inferFilePath: (documentOrUri: string | TextDocument | URI | undefined) => string | undefined;

	const saveRuleConfigCache = new LRUCache<string, SaveRuleConfigItem | null>(128);
	export async function get(uri: string, settings: TextDocumentSettings  & { library: ESLintModule }): Promise<SaveRuleConfigItem | undefined> {
		const filePath = inferFilePath(uri);
		let result = saveRuleConfigCache.get(uri);
		if (filePath === undefined || result === null) {
			return undefined;
		}
		if (result !== undefined) {
			return result;
		}
		const rules = settings.codeActionOnSave.rules;
		result = await ESLint.withClass(async (eslint) => {
			if (rules === undefined || eslint.isCLIEngine) {
				return undefined;
			}
			const config = await eslint.calculateConfigForFile(filePath);
			if (config === undefined || config.rules === undefined || config.rules.length === 0) {
				return undefined;
			}
			const offRules: Set<string> = new Set();
			const onRules: Set<string> = new Set();
			if (rules.length === 0) {
				Object.keys(config.rules).forEach(ruleId => offRules.add(ruleId));
			} else {
				for (const ruleId of Object.keys(config.rules)) {
					if (isOff(ruleId, rules)) {
						offRules.add(ruleId);
					} else {
						onRules.add(ruleId);
					}
				}
			}
			return offRules.size > 0 ? { offRules, onRules } : undefined;
		}, settings);
		if (result === undefined || result === null) {
			saveRuleConfigCache.set(uri, null);
			return undefined;
		} else {
			saveRuleConfigCache.set(uri, result);
			return result;
		}
	}
	export function remove(key: string): boolean {
		return saveRuleConfigCache.delete(key);
	}

	export function clear(): void {
		saveRuleConfigCache.clear();
	}

	function isOff(ruleId: string, matchers: string[]): boolean {
		for (const matcher of matchers) {
			if (matcher.startsWith('!') && new RegExp(`^${matcher.slice(1).replace(/\*/g, '.*')}$`, 'g').test(ruleId)) {
				return true;
			} else if (new RegExp(`^${matcher.replace(/\*/g, '.*')}$`, 'g').test(ruleId)) {
				return false;
			}
		}
		return true;
	}
}

/**
 * Manages rule severity overrides done using VS Code settings.
 */
export namespace RuleSeverities {

	const ruleSeverityCache = new LRUCache<string, RuleSeverity | null>(1024);

	export function getOverride(ruleId: string, customizations: RuleCustomization[]): RuleSeverity | undefined {
		let result: RuleSeverity | undefined | null = ruleSeverityCache.get(ruleId);
		if (result === null) {
			return undefined;
		}
		if (result !== undefined) {
			return result;
		}
		for (const customization of customizations) {
			if (asteriskMatches(customization.rule, ruleId)) {
				result = customization.severity;
			}
		}
		if (result === undefined) {
			ruleSeverityCache.set(ruleId, null);
			return undefined;
		}

		ruleSeverityCache.set(ruleId, result);
		return result;
	}

	export function clear(): void {
		ruleSeverityCache.clear();
	}

	function asteriskMatches(matcher: string, ruleId: string): boolean {
		return matcher.startsWith('!')
			? !(new RegExp(`^${matcher.slice(1).replace(/\*/g, '.*')}$`, 'g').test(ruleId))
			: new RegExp(`^${matcher.replace(/\*/g, '.*')}$`, 'g').test(ruleId);
	}
}


/**
 * Creates LSP Diagnostics and captures code action information.
 */
namespace Diagnostics {

	export function computeKey(diagnostic: Diagnostic): string {
		const range = diagnostic.range;
		let message: string | undefined;
		if (diagnostic.message) {
			const hash  = crypto.createHash('md5');
			hash.update(diagnostic.message);
			message = hash.digest('base64');
		}
		return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}-${message ?? ''}`;
	}

	export function create(settings: TextDocumentSettings, problem: ESLintProblem, document: TextDocument): [Diagnostic, RuleSeverity | undefined] {
		const message = problem.message;
		const startLine = typeof problem.line !== 'number' || Number.isNaN(problem.line) ? 0 : Math.max(0, problem.line - 1);
		const startChar = typeof problem.column !== 'number' || Number.isNaN(problem.column) ? 0 : Math.max(0, problem.column - 1);
		let endLine = typeof problem.endLine !== 'number' || Number.isNaN(problem.endLine) ? startLine : Math.max(0, problem.endLine - 1);
		let endChar = typeof problem.endColumn !== 'number' || Number.isNaN(problem.endColumn) ? startChar : Math.max(0, problem.endColumn - 1);
		if (settings.problems.shortenToSingleLine && endLine !== startLine) {
			const startLineText = document.getText({
				start: {
					line: startLine,
					character: 0,
				},
				end: {
					line: startLine,
					character: uinteger.MAX_VALUE,
				}
			});
			endLine = startLine;
			endChar = startLineText.length;
		}
		const override = RuleSeverities.getOverride(problem.ruleId, settings.rulesCustomizations);
		const result: Diagnostic = {
			message: message,
			severity: convertSeverityToDiagnosticWithOverride(problem.severity, override),
			source: 'eslint',
			range: {
				start: { line: startLine, character: startChar },
				end: { line: endLine, character: endChar }
			}
		};
		if (problem.ruleId) {
			const url = RuleMetaData.getUrl(problem.ruleId);
			result.code = problem.ruleId;
			if (url !== undefined) {
				result.codeDescription = {
					href: url
				};
			}
			if (problem.ruleId === 'no-unused-vars') {
				result.tags = [DiagnosticTag.Unnecessary];
			}
		}

		return [result, override];
	}

	function adjustSeverityForOverride(severity: number | RuleSeverity, severityOverride?: RuleSeverity) {
		switch (severityOverride) {
			case RuleSeverity.off:
			case RuleSeverity.info:
			case RuleSeverity.warn:
			case RuleSeverity.error:
				return severityOverride;

			case RuleSeverity.downgrade:
				switch (convertSeverityToDiagnostic(severity)) {
					case DiagnosticSeverity.Error:
						return RuleSeverity.warn;
					case DiagnosticSeverity.Warning:
					case DiagnosticSeverity.Information:
						return RuleSeverity.info;
				}

			case RuleSeverity.upgrade:
				switch (convertSeverityToDiagnostic(severity)) {
					case DiagnosticSeverity.Information:
						return RuleSeverity.warn;
					case DiagnosticSeverity.Warning:
					case DiagnosticSeverity.Error:
						return RuleSeverity.error;
				}

			default:
				return severity;
		}
	}

	function convertSeverityToDiagnostic(severity: number | RuleSeverity) {
	// RuleSeverity concerns an overridden rule. A number is direct from ESLint.
		switch (severity) {
		// Eslint 1 is warning
			case 1:
			case RuleSeverity.warn:
				return DiagnosticSeverity.Warning;
			case 2:
			case RuleSeverity.error:
				return DiagnosticSeverity.Error;
			case RuleSeverity.info:
				return DiagnosticSeverity.Information;
			default:
				return DiagnosticSeverity.Error;
		}
	}

	function convertSeverityToDiagnosticWithOverride(severity: number | RuleSeverity, severityOverride: RuleSeverity | undefined): DiagnosticSeverity {
		return convertSeverityToDiagnostic(adjustSeverityForOverride(severity, severityOverride));

	}
}

/**
 * Capture information necessary to compute code actions.
 */
export namespace CodeActions {
	const codeActions: Map<string, Map<string, Problem>> = new Map<string, Map<string, Problem>>();

	export function get(uri: string): Map<string, Problem> | undefined {
		return codeActions.get(uri);
	}

	export function set(uri: string, value: Map<string, Problem>): void {
		codeActions.set(uri, value);
	}

	export function remove(uri: string): boolean {
		return codeActions.delete(uri);
	}

	export function record(document: TextDocument, diagnostic: Diagnostic, problem: ESLintProblem): void {
		if (!problem.ruleId) {
			return;
		}
		const uri = document.uri;
		let edits: Map<string, Problem> | undefined = CodeActions.get(uri);
		if (edits === undefined) {
			edits = new Map<string, Problem>();
			CodeActions.set(uri, edits);
		}
		edits.set(Diagnostics.computeKey(diagnostic), {
			label: `Fix this ${problem.ruleId} problem`,
			documentVersion: document.version,
			ruleId: problem.ruleId,
			line: problem.line,
			diagnostic: diagnostic,
			edit: problem.fix,
			suggestions: problem.suggestions
		});
	}
}

/**
 * Wrapper round the ESLint npm module.
 */
export namespace ESLint {

	let connection: ProposedFeatures.Connection;
	let documents: TextDocuments<TextDocument>;
	let inferFilePath: (documentOrUri: string | TextDocument | URI | undefined) => string | undefined;
	let loadNodeModule: <T>(moduleName: string) => T | undefined;

	const languageId2ParserRegExp: Map<string, RegExp[]> = function createLanguageId2ParserRegExp() {
		const result = new Map<string, RegExp[]>();
		const typescript = /\/@typescript-eslint\/parser\//;
		const babelESLint = /\/babel-eslint\/lib\/index.js$/;
		const vueESLint = /\/vue-eslint-parser\/index.js$/;
		result.set('typescript', [typescript, babelESLint, vueESLint]);
		result.set('typescriptreact', [typescript, babelESLint, vueESLint]);

		const angular = /\/@angular-eslint\/template-parser\//;
		result.set('html', [angular]);

		return result;
	}();

	const languageId2ParserOptions: Map<string, { regExps: RegExp[]; parsers: Set<string>; parserRegExps?: RegExp[] }> = function createLanguageId2ParserOptionsRegExp() {
		const result = new Map<string, { regExps: RegExp[]; parsers: Set<string>; parserRegExps?: RegExp[] }>();
		const vue = /vue-eslint-parser\/.*\.js$/;
		const typescriptEslintParser = /@typescript-eslint\/parser\/.*\.js$/;
		result.set('typescript', { regExps: [vue], parsers: new Set<string>(['@typescript-eslint/parser']), parserRegExps: [typescriptEslintParser] });
		return result;
	}();

	const languageId2PluginName: Map<string, string> = new Map([
		['html', 'html'],
		['vue', 'vue'],
		['markdown', 'markdown']
	]);

	const defaultLanguageIds: Set<string> = new Set([
		'javascript', 'javascriptreact'
	]);

	const projectFolderIndicators: {
		fileName: string;
		isRoot: boolean;
	}[] = [
		{ fileName: 'package.json', isRoot: true },
		{ fileName: '.eslintignore', isRoot: true },
		{ fileName: 'eslint.config.js', isRoot: true },
		{ fileName: '.eslintrc', isRoot: false },
		{ fileName: '.eslintrc.json', isRoot: false },
		{ fileName: '.eslintrc.js', isRoot: false },
		{ fileName: '.eslintrc.yaml', isRoot: false },
		{ fileName: '.eslintrc.yml', isRoot: false },
	];

	const path2Library: Map<string, ESLintModule> = new Map<string, ESLintModule>();
	const document2Settings: Map<string, Promise<TextDocumentSettings>> = new Map<string, Promise<TextDocumentSettings>>();
	const formatterRegistrations: Map<string, Promise<Disposable>> = new Map();

	export function initialize($connection: ProposedFeatures.Connection, $documents: TextDocuments<TextDocument>, $inferFilePath: (documentOrUri: string | TextDocument | URI | undefined) => string | undefined, $loadNodeModule: <T>(moduleName: string) => T | undefined) {
		connection = $connection;
		documents = $documents;
		inferFilePath = $inferFilePath;
		loadNodeModule = $loadNodeModule;
	}

	export function removeSettings(key: string): boolean {
		return document2Settings.delete(key);
	}

	export function clearSettings(): void {
		document2Settings.clear();
	}

	export function unregisterAsFormatter(document: TextDocument): void {
		const unregister = formatterRegistrations.get(document.uri);
		if (unregister !== undefined) {
			void unregister.then(disposable => disposable.dispose());
			formatterRegistrations.delete(document.uri);
		}
	}

	export function clearFormatters(): void {
		for (const unregistration of formatterRegistrations.values()) {
			void unregistration.then(disposable => disposable.dispose());
		}
		formatterRegistrations.clear();
	}

	export function resolveSettings(document: TextDocument): Promise<TextDocumentSettings> {
		const uri = document.uri;
		let resultPromise = document2Settings.get(uri);
		if (resultPromise) {
			return resultPromise;
		}
		resultPromise = connection.workspace.getConfiguration({ scopeUri: uri, section: '' }).then((configuration: ConfigurationSettings) => {
			const settings: TextDocumentSettings = Object.assign(
				{},
				configuration,
				{ silent: false, library: undefined, resolvedGlobalPackageManagerPath: undefined },
				{ workingDirectory: undefined}
			);
			if (settings.validate === Validate.off) {
				return settings;
			}
			settings.resolvedGlobalPackageManagerPath = GlobalPaths.get(settings.packageManager);
			const filePath = inferFilePath(document);
			const workspaceFolderPath = settings.workspaceFolder !== undefined ? inferFilePath(settings.workspaceFolder.uri) : undefined;
			const hasUserDefinedWorkingDirectories: boolean = configuration.workingDirectory !== undefined;
			const workingDirectoryConfig = configuration.workingDirectory ?? { mode: ModeEnum.location };
			if (ModeItem.is(workingDirectoryConfig)) {
				let candidate: string | undefined;
				if (workingDirectoryConfig.mode === ModeEnum.location) {
					if (workspaceFolderPath !== undefined) {
						candidate = workspaceFolderPath;
					} else if (filePath !== undefined && !isUNC(filePath)) {
						candidate = path.dirname(filePath);
					}
				} else if (workingDirectoryConfig.mode === ModeEnum.auto) {
					if (workspaceFolderPath !== undefined) {
						candidate = findWorkingDirectory(workspaceFolderPath, filePath);
					} else if (filePath !== undefined && !isUNC(filePath)) {
						candidate = path.dirname(filePath);
					}
				}
				if (candidate !== undefined && fs.existsSync(candidate)) {
					settings.workingDirectory = { directory: candidate };
				}
			} else {
				settings.workingDirectory = workingDirectoryConfig;
			}
			let promise: Promise<string>;
			let nodePath: string | undefined;
			if (settings.nodePath !== null) {
				nodePath = settings.nodePath;
				if (!path.isAbsolute(nodePath) && workspaceFolderPath !== undefined) {
					nodePath = path.join(workspaceFolderPath, nodePath);
				}
			}
			let moduleResolveWorkingDirectory: string | undefined;
			if (!hasUserDefinedWorkingDirectories && filePath !== undefined) {
				moduleResolveWorkingDirectory = path.dirname(filePath);
			}
			if (moduleResolveWorkingDirectory === undefined && settings.workingDirectory !== undefined && !settings.workingDirectory['!cwd']) {
				moduleResolveWorkingDirectory = settings.workingDirectory.directory;
			}

			// During Flat Config is considered experimental,
			// we need to import FlatESLint from 'eslint/use-at-your-own-risk'.
			// See: https://eslint.org/blog/2022/08/new-config-system-part-3/
			const eslintPath = settings.experimental.useFlatConfig ? 'eslint/use-at-your-own-risk' : 'eslint';
			if (nodePath !== undefined) {
				promise = Files.resolve(eslintPath, nodePath, nodePath, trace).then<string, string>(undefined, () => {
					return Files.resolve(eslintPath, settings.resolvedGlobalPackageManagerPath, moduleResolveWorkingDirectory, trace);
				});
			} else {
				promise = Files.resolve(eslintPath, settings.resolvedGlobalPackageManagerPath, moduleResolveWorkingDirectory, trace);
			}

			settings.silent = settings.validate === Validate.probe;
			return promise.then(async (libraryPath) => {
				let library = path2Library.get(libraryPath);
				if (library === undefined) {
					if (settings.experimental.useFlatConfig) {
						const lib = loadNodeModule<{ FlatESLint?: ESLintClassConstructor }>(libraryPath);
						if (lib === undefined) {
							settings.validate = Validate.off;
							if (!settings.silent) {
								connection.console.error(`Failed to load eslint library from ${libraryPath}. If you are using ESLint v8.21 or earlier, try upgrading it. For newer versions, try disabling the 'eslint.experimental.useFlatConfig' setting. See the output panel for more information.`);
							}
						} else if (lib.FlatESLint === undefined) {
							settings.validate = Validate.off;
							connection.console.error(`The eslint library loaded from ${libraryPath} doesn\'t export a FlatESLint class.`);
						} else {
							connection.console.info(`ESLint library loaded from: ${libraryPath}`);
							// pretend to be a regular eslint endpoint
							library = {
								ESLint: lib.FlatESLint,
								isFlatConfig: true,
								CLIEngine: undefined,
							};
							settings.library = library;
							path2Library.set(libraryPath, library);
						}
					} else {
						library = loadNodeModule(libraryPath);
						if (library === undefined) {
							settings.validate = Validate.off;
							if (!settings.silent) {
								connection.console.error(`Failed to load eslint library from ${libraryPath}. See output panel for more information.`);
							}
						} else if (library.CLIEngine === undefined && library.ESLint === undefined) {
							settings.validate = Validate.off;
							connection.console.error(`The eslint library loaded from ${libraryPath} doesn\'t export neither a CLIEngine nor an ESLint class. You need at least eslint@1.0.0`);
						} else {
							connection.console.info(`ESLint library loaded from: ${libraryPath}`);
							settings.library = library;
							path2Library.set(libraryPath, library);
						}
					}
				} else {
					settings.library = library;
				}
				if (settings.validate === Validate.probe && TextDocumentSettings.hasLibrary(settings)) {
					settings.validate = Validate.off;
					let filePath = ESLint.getFilePath(document, settings);
					if (filePath !== undefined) {
						const parserRegExps = languageId2ParserRegExp.get(document.languageId);
						const pluginName = languageId2PluginName.get(document.languageId);
						const parserOptions = languageId2ParserOptions.get(document.languageId);
						if (defaultLanguageIds.has(document.languageId)) {
							settings.validate = Validate.on;
						} else if (parserRegExps !== undefined || pluginName !== undefined || parserOptions !== undefined) {
							const eslintConfig: ESLintConfig | undefined = await ESLint.withClass(async (eslintClass) => {
								try {
									return eslintClass.calculateConfigForFile(filePath!);
								} catch (err) {
									return undefined;
								}
							}, settings);
							if (eslintConfig !== undefined) {
								if (ESLintModule.isFlatConfig(settings.library)) {
									// We have a flat configuration. This means that the config file needs to
									// have a section per file extension we want to validate. If there is none than
									// `calculateConfigForFile` will return no config since the config options without
									// a `files` property only applies to `**/*.js, **/*.cjs, and **/*.mjs` by default
									// See https://eslint.org/docs/latest/user-guide/configuring/configuration-files-new#specifying-files-and-ignores

									// This means since we have found a configuration for the given file we assume that
									// that configuration is correctly pointing to a parser.
									settings.validate = Validate.on;
								} else {
									const parser: string | undefined =  eslintConfig.parser !== null
										? normalizePath(eslintConfig.parser)
										: undefined;
									if (parser !== undefined) {
										if (parserRegExps !== undefined) {
											for (const regExp of parserRegExps) {
												if (regExp.test(parser)) {
													settings.validate = Validate.on;
													break;
												}
											}
										}
										if (settings.validate !== Validate.on && parserOptions !== undefined && typeof eslintConfig.parserOptions?.parser === 'string') {
											const eslintConfigParserOptionsParser = normalizePath(eslintConfig.parserOptions.parser);
											for (const regExp of parserOptions.regExps) {
												if (regExp.test(parser) && (
													parserOptions.parsers.has(eslintConfig.parserOptions.parser) ||
											parserOptions.parserRegExps !== undefined && parserOptions.parserRegExps.some(parserRegExp => parserRegExp.test(eslintConfigParserOptionsParser))
												)) {
													settings.validate = Validate.on;
													break;
												}
											}
										}
									}
									if (settings.validate !== Validate.on && Array.isArray(eslintConfig.plugins) && eslintConfig.plugins.length > 0 && pluginName !== undefined) {
										for (const name of eslintConfig.plugins) {
											if (name === pluginName) {
												settings.validate = Validate.on;
												break;
											}
										}
									}
								}
							}
						}
					}
					if (settings.validate === Validate.off) {
						const params: ProbeFailedParams = { textDocument: { uri: document.uri } };
						void connection.sendRequest(ProbeFailedRequest.type, params);
					}
				}
				if (settings.validate === Validate.on) {
					settings.silent = false;
					if (settings.format && TextDocumentSettings.hasLibrary(settings)) {
						const Uri = URI.parse(uri);
						const isFile = Uri.scheme === 'file';
						let pattern: string = isFile
							? Uri.fsPath.replace(/\\/g, '/')
							: Uri.fsPath;
						pattern = pattern.replace(/[\[\]\{\}]/g, '?');

						const filter: DocumentFilter = { scheme: Uri.scheme, pattern: pattern };
						const options: DocumentFormattingRegistrationOptions = { documentSelector: [filter] };
						if (!isFile) {
							formatterRegistrations.set(uri, connection.client.register(DocumentFormattingRequest.type, options));
						} else {
							const filePath = inferFilePath(uri)!;
							await ESLint.withClass(async (eslintClass) => {
								if (!await eslintClass.isPathIgnored(filePath)) {
									formatterRegistrations.set(uri, connection.client.register(DocumentFormattingRequest.type, options));
								}
							}, settings);
						}
					}
				}
				return settings;
			}, () => {
				settings.validate = Validate.off;
				if (!settings.silent) {
					void connection.sendRequest(NoESLintLibraryRequest.type, { source: { uri: document.uri } });
				}
				return settings;
			});
		});
		document2Settings.set(uri, resultPromise);
		return resultPromise;
	}

	export function newClass(library: ESLintModule, newOptions: ESLintClassOptions | CLIOptions, useESLintClass: boolean): ESLintClass {
		if (ESLintModule.hasESLintClass(library) && useESLintClass) {
			return new library.ESLint(newOptions);
		}
		if (ESLintModule.hasCLIEngine(library)) {
			return new ESLintClassEmulator(new library.CLIEngine(newOptions));
		}
		return new library.ESLint(newOptions);
	}

	export async function withClass<T>(func: (eslintClass: ESLintClass) => Promise<T>, settings: TextDocumentSettings & { library: ESLintModule }, options?: ESLintClassOptions | CLIOptions): Promise<T> {
		const newOptions: ESLintClassOptions | CLIOptions = options === undefined
			? Object.assign(Object.create(null), settings.options)
			: Object.assign(Object.create(null), settings.options, options);

		const cwd = process.cwd();
		try {
			if (settings.workingDirectory) {
			// A lot of libs are sensitive to drive letter casing and assume a
			// capital drive letter. Make sure we support that correctly.
				const newCWD = normalizeWorkingDirectory(settings.workingDirectory.directory);
				newOptions.cwd = newCWD;
				if (settings.workingDirectory['!cwd'] !== true && fs.existsSync(newCWD)) {
					process.chdir(newCWD);
				}
			}

			const eslintClass = newClass(settings.library, newOptions, settings.useESLintClass);
			// We need to await the result to ensure proper execution of the
			// finally block.
			return await func(eslintClass);
		} finally {
			if (cwd !== process.cwd()) {
				process.chdir(cwd);
			}
		}
	}

	function normalizeWorkingDirectory(value: string): string {
		const result = normalizeDriveLetter(value);
		if (result.length === 0) {
			return result;
		}
		return result[result.length - 1] === path.sep
			? result.substring(0, result.length - 1)
			: result;
	}

	export function getFilePath(document: TextDocument | undefined, settings: TextDocumentSettings): string | undefined {
		if (document === undefined) {
			return undefined;
		}
		const uri = URI.parse(document.uri);
		if (uri.scheme !== 'file') {
			if (settings.workspaceFolder !== undefined) {
				const ext = LanguageDefaults.getExtension(document.languageId);
				const workspacePath = inferFilePath(settings.workspaceFolder.uri);
				if (workspacePath !== undefined && ext !== undefined) {
					return path.join(workspacePath, `test.${ext}`);
				}
			}
			return undefined;
		} else {
			return inferFilePath(uri);
		}
	}

	const validFixTypes = new Set<string>(['problem', 'suggestion', 'layout', 'directive']);
	export async function validate(document: TextDocument, settings: TextDocumentSettings & { library: ESLintModule }): Promise<Diagnostic[]> {
		const newOptions: CLIOptions = Object.assign(Object.create(null), settings.options);
		let fixTypes: Set<string> | undefined = undefined;
		if (Array.isArray(newOptions.fixTypes) && newOptions.fixTypes.length > 0) {
			fixTypes = new Set();
			for (const item of newOptions.fixTypes) {
				if (validFixTypes.has(item)) {
					fixTypes.add(item);
				}
			}
			if (fixTypes.size === 0) {
				fixTypes = undefined;
			}
		}

		const content = document.getText();
		const uri = document.uri;
		const file = getFilePath(document, settings);

		return withClass(async (eslintClass) => {
			CodeActions.remove(uri);
			const reportResults: ESLintDocumentReport[] = await eslintClass.lintText(content, { filePath: file, warnIgnored: settings.onIgnoredFiles !== ESLintSeverity.off });
			RuleMetaData.capture(eslintClass, reportResults);
			const diagnostics: Diagnostic[] = [];
			if (reportResults && Array.isArray(reportResults) && reportResults.length > 0) {
				const docReport = reportResults[0];
				if (docReport.messages && Array.isArray(docReport.messages)) {
					docReport.messages.forEach((problem) => {
						if (problem) {
							const [diagnostic, override] = Diagnostics.create(settings, problem, document);
							if (!(override === RuleSeverity.off || (settings.quiet && diagnostic.severity === DiagnosticSeverity.Warning))) {
								diagnostics.push(diagnostic);
							}
							if (fixTypes !== undefined && problem.ruleId !== undefined && problem.fix !== undefined) {
								const type = RuleMetaData.getType(problem.ruleId);
								if (type !== undefined && fixTypes.has(type)) {
									CodeActions.record(document, diagnostic, problem);
								}
							} else {
								if (RuleMetaData.isUnusedDisableDirectiveProblem(problem)) {
									problem.ruleId = RuleMetaData.unusedDisableDirectiveId;
								}

								CodeActions.record(document, diagnostic, problem);
							}
						}
					});
				}
			}
			return diagnostics;
		}, settings);
	}

	function trace(message: string, verbose?: string): void {
		connection.tracer.log(message, verbose);
	}

	/**
	 * Global paths for the different package managers
	 */
	namespace GlobalPaths {
		const globalPaths: Record<string, { cache: string | undefined; get(): string | undefined; }> = {
			yarn: {
				cache: undefined,
				get(): string | undefined {
					return Files.resolveGlobalYarnPath(trace);
				}
			},
			npm: {
				cache: undefined,
				get(): string | undefined {
					return Files.resolveGlobalNodePath(trace);
				}
			},
			pnpm: {
				cache: undefined,
				get(): string {
					const pnpmPath = execSync('pnpm root -g').toString().trim();
					return pnpmPath;
				}
			}
		};

		export function get(packageManager: PackageManagers): string | undefined {
			const pm = globalPaths[packageManager];
			if (pm) {
				if (pm.cache === undefined) {
					pm.cache = pm.get();
				}
				return pm.cache;
			}
			return undefined;
		}
	}

	export function findWorkingDirectory(workspaceFolder: string, file: string | undefined): string | undefined {
		if (file === undefined || isUNC(file)) {
			return workspaceFolder;
		}
		// Don't probe for something in node modules folder.
		if (file.indexOf(`${path.sep}node_modules${path.sep}`) !== -1) {
			return workspaceFolder;
		}

		let result: string = workspaceFolder;
		let directory: string | undefined = path.dirname(file);
		outer: while (directory !== undefined && directory.startsWith(workspaceFolder)) {
			for (const { fileName, isRoot } of projectFolderIndicators) {
				if (fs.existsSync(path.join(directory, fileName))) {
					result = directory;
					if (isRoot) {
						break outer;
					} else {
						break;
					}
				}
			}
			const parent = path.dirname(directory);
			directory = parent !== directory ? parent : undefined;
		}
		return result;
	}

	export namespace ErrorHandlers {

		export const single: ((error: any, document: TextDocument, library: ESLintModule) => Status | undefined)[] = [
			tryHandleNoConfig,
			tryHandleConfigError,
			tryHandleMissingModule,
			showErrorMessage
		];

		export function getMessage(err: any, document: TextDocument): string {
			let result: string | undefined = undefined;
			if (typeof err.message === 'string' || err.message instanceof String) {
				result = <string>err.message;
				result = result.replace(/\r?\n/g, ' ');
				if (/^CLI: /.test(result)) {
					result = result.substr(5);
				}
			} else {
				result = `An unknown error occurred while validating document: ${document.uri}`;
			}
			return result;
		}

		const noConfigReported: Map<string, ESLintModule> = new Map<string, ESLintModule>();

		export function clearNoConfigReported(): void {
			noConfigReported.clear();
		}

		function tryHandleNoConfig(error: any, document: TextDocument, library: ESLintModule): Status | undefined {
			if (!ESLintError.isNoConfigFound(error)) {
				return undefined;
			}
			if (!noConfigReported.has(document.uri)) {
				connection.sendRequest(
					NoConfigRequest.type,
					{
						message: getMessage(error, document),
						document: {
							uri: document.uri
						}
					}
				).then(undefined, () => { });
				noConfigReported.set(document.uri, library);
			}
			return Status.warn;
		}

		const configErrorReported: Map<string, ESLintModule> = new Map<string, ESLintModule>();

		export function getConfigErrorReported(key: string): ESLintModule | undefined {
			return configErrorReported.get(key);
		}

		export function removeConfigErrorReported(key: string): boolean {
			return configErrorReported.delete(key);
		}

		function tryHandleConfigError(error: any, document: TextDocument, library: ESLintModule): Status | undefined {
			if (!error.message) {
				return undefined;
			}

			function handleFileName(filename: string): Status {
				if (!configErrorReported.has(filename)) {
					connection.console.error(getMessage(error, document));
					if (!documents.get(URI.file(filename).toString())) {
						connection.window.showInformationMessage(getMessage(error, document));
					}
					configErrorReported.set(filename, library);
				}
				return Status.warn;
			}

			let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(error.message);
			if (matches && matches.length === 3) {
				return handleFileName(matches[1]);
			}

			matches = /(.*):\n\s*Configuration for rule \"(.*)\" is /.exec(error.message);
			if (matches && matches.length === 3) {
				return handleFileName(matches[1]);
			}

			matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(error.message);
			if (matches && matches.length === 3) {
				return handleFileName(matches[2]);
			}

			return undefined;
		}

		const missingModuleReported: Map<string, ESLintModule> = new Map<string, ESLintModule>();

		export function clearMissingModuleReported(): void {
			missingModuleReported.clear();
		}

		function tryHandleMissingModule(error: any, document: TextDocument, library: ESLintModule): Status | undefined {
			if (!error.message) {
				return undefined;
			}

			function handleMissingModule(plugin: string, module: string, error: ESLintError): Status {
				if (!missingModuleReported.has(plugin)) {
					const fsPath = inferFilePath(document);
					missingModuleReported.set(plugin, library);
					if (error.messageTemplate === 'plugin-missing') {
						connection.console.error([
							'',
							`${error.message.toString()}`,
							`Happened while validating ${fsPath ? fsPath : document.uri}`,
							`This can happen for a couple of reasons:`,
							`1. The plugin name is spelled incorrectly in an ESLint configuration file (e.g. .eslintrc).`,
							`2. If ESLint is installed globally, then make sure ${module} is installed globally as well.`,
							`3. If ESLint is installed locally, then ${module} isn't installed correctly.`,
							'',
							`Consider running eslint --debug ${fsPath ? fsPath : document.uri} from a terminal to obtain a trace about the configuration files used.`
						].join('\n'));
					} else {
						connection.console.error([
							`${error.message.toString()}`,
							`Happened while validating ${fsPath ? fsPath : document.uri}`
						].join('\n'));
					}
				}
				return Status.warn;
			}

			const matches = /Failed to load plugin (.*): Cannot find module (.*)/.exec(error.message);
			if (matches && matches.length === 3) {
				return handleMissingModule(matches[1], matches[2], error);
			}

			return undefined;
		}

		function showErrorMessage(error: any, document: TextDocument): Status {
			if (Is.string(error.stack)) {
				connection.console.error('An unexpected error occurred:');
				connection.console.error(error.stack);
			} else {
				connection.console.error(`An unexpected error occurred: ${getMessage(error, document)}.`);
			}
			return Status.error;
		}
	}
}