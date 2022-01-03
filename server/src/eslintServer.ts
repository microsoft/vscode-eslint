/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { EOL } from 'os';

import {
	createConnection, Connection, ResponseError, RequestType, NotificationType, RequestHandler, NotificationHandler,
	Diagnostic, DiagnosticSeverity, Range, Files, CancellationToken, TextDocuments, TextDocumentSyncKind, TextEdit,
	TextDocumentIdentifier, Command, WorkspaceChange, CodeActionRequest, VersionedTextDocumentIdentifier,
	ExecuteCommandRequest, DidChangeWatchedFilesNotification, DidChangeConfigurationNotification, WorkspaceFolder,
	DidChangeWorkspaceFoldersNotification, CodeAction, CodeActionKind, Position, DocumentFormattingRequest,
	DocumentFormattingRegistrationOptions, Disposable, DocumentFilter, TextDocumentEdit, LSPErrorCodes, DiagnosticTag, NotificationType0,
	Message as LMessage, RequestMessage as LRequestMessage, ResponseMessage as LResponseMessage, uinteger
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { URI } from 'vscode-uri';

import { stringDiff } from './diff';
import { LRUCache } from './linkedMap';

namespace Is {
	const toString = Object.prototype.toString;

	export function boolean(value: any): value is boolean {
		return value === true || value === false;
	}

	export function nullOrUndefined(value: any): value is null | undefined {
		return value === null || value === undefined;
	}

	export function string(value: any): value is string {
		return toString.call(value) === '[object String]';
	}
}

namespace CommandIds {
	export const applySingleFix: string = 'eslint.applySingleFix';
	export const applySuggestion: string = 'eslint.applySuggestion';
	export const applySameFixes: string = 'eslint.applySameFixes';
	export const applyAllFixes: string = 'eslint.applyAllFixes';
	export const applyDisableLine: string = 'eslint.applyDisableLine';
	export const applyDisableFile: string = 'eslint.applyDisableFile';
	export const openRuleDoc: string = 'eslint.openRuleDoc';
}

interface ESLintError extends Error {
	messageTemplate?: string;
	messageData?: {
		pluginName?: string;
	};
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

type RunValues = 'onType' | 'onSave';

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

interface CodeActionSettings {
	disableRuleComment: {
		enable: boolean;
		location: 'separateLine' | 'sameLine';
	};
	showDocumentation: {
		enable: boolean;
	};
}

type PackageManagers = 'npm' | 'yarn' | 'pnpm';

type ESLintOptions = object & { fixTypes?: string[] };
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

enum CodeActionsOnSaveMode {
	all = 'all',
	problems = 'problems'
}

interface CodeActionsOnSaveSettings {
	enable: boolean;
	mode: CodeActionsOnSaveMode;
	rules?: string[];
}

enum RuleSeverity {
	// Original ESLint values
	info = 'info',
	warn = 'warn',
	error = 'error',

	// Added severity override changes
	off = 'off',
	default = 'default',
	downgrade = 'downgrade',
	upgrade = 'upgrade'
}

interface RuleCustomization  {
	rule: string;
	severity: RuleSeverity;
}

interface CommonSettings {
	validate: Validate;
	packageManager: 'npm' | 'yarn' | 'pnpm';
	useESLintClass: boolean;
	codeAction: CodeActionSettings;
	codeActionOnSave: CodeActionsOnSaveSettings;
	format: boolean;
	quiet: boolean;
	onIgnoredFiles: ESLintSeverity;
	options: ESLintOptions | undefined;
	rulesCustomizations: RuleCustomization[];
	run: RunValues;
	nodePath: string | null;
	workspaceFolder: WorkspaceFolder | undefined;
}

interface ConfigurationSettings extends CommonSettings {
	workingDirectory: ModeItem | DirectoryItem | undefined;
}

interface TextDocumentSettings extends CommonSettings {
	silent: boolean;
	workingDirectory: DirectoryItem | undefined;
	library: ESLintModule | undefined;
	resolvedGlobalPackageManagerPath: string | undefined;
}

namespace TextDocumentSettings {
	export function hasLibrary(settings: TextDocumentSettings): settings is (TextDocumentSettings & { library: ESLintModule }) {
		return settings.library !== undefined;
	}
}

interface ESLintAutoFixEdit {
	range: [number, number];
	text: string;
}

interface ESLintSuggestionResult {
	desc: string;
	fix: ESLintAutoFixEdit;
}

interface ESLintProblem {
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutoFixEdit;
	suggestions?: ESLintSuggestionResult[]
}

interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
	output?: string;
}

interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}

interface CLIOptions {
	cwd?: string;
	fixTypes?: string[];
	fix?: boolean;
}

type SeverityConf = 0 | 1 | 2 | 'off' | 'warn' | 'error';

type RuleConf = SeverityConf | [SeverityConf, ...any[]];

type ConfigData = {
	rules?: Record<string, RuleConf>;
};

interface ESLintClassOptions {
	cwd?: string;
	fixTypes?: string[];
	fix?: boolean;
	overrideConfig?: ConfigData;
}

type RuleMetaData = {
	docs?: {
		url?: string;
	};
	type?: string;
};

// { meta: { docs: [Object], schema: [Array] }, create: [Function: create] }
type RuleData = {
	meta?: RuleMetaData;
};

namespace RuleData {
	export function hasMetaType(value: RuleMetaData | undefined): value is RuleMetaData & { type: string; } {
		return value !== undefined && value.type !== undefined;
	}
}

interface ParserOptions {
	parser?: string;
}

interface ESLintConfig {
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

type ESLintModule =
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
	CLIEngine: undefined;
};

namespace ESLintModule {
	export function hasESLintClass(value: ESLintModule): value is { ESLint: ESLintClassConstructor; CLIEngine: CLIEngineConstructor | undefined;} {
		return value.ESLint !== undefined;
	}
	export function hasCLIEngine(value: ESLintModule): value is { CLIEngine: CLIEngineConstructor; ESLint: ESLintClassConstructor | undefined; } {
		return value.CLIEngine !== undefined;
	}
}

namespace ESLintClass {
	export function newESLintClass(library: ESLintModule, newOptions: ESLintClassOptions | CLIOptions, useESLintClass: boolean): ESLintClass {
		if (ESLintModule.hasESLintClass(library) && useESLintClass) {
			return new library.ESLint(newOptions);
		}
		if (ESLintModule.hasCLIEngine(library)) {
			return new ESLintClassEmulator(new library.CLIEngine(newOptions));
		}
		return new library.ESLint(newOptions);
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

namespace RuleMetaData {
	const handled: Set<string> = new Set();
	const ruleId2Meta: Map<string, RuleMetaData> = new Map();

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
}

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;
function loadNodeModule<T>(moduleName: string): T | undefined {
	const r = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require;
	try {
		return r(moduleName);
	} catch (err: any) {
		if (err.stack) {
			connection.console.error(err.stack.toString());
		}
	}
	return undefined;
}

const ruleSeverityCache = new LRUCache<string, RuleSeverity | null>(1024);

function asteriskMatches(matcher: string, ruleId: string): boolean {
	return matcher.startsWith('!')
		? !(new RegExp(`^${matcher.slice(1).replace(/\*/g, '.*')}$`, 'g').test(ruleId))
		: new RegExp(`^${matcher.replace(/\*/g, '.*')}$`, 'g').test(ruleId);
}

function getSeverityOverride(ruleId: string, customizations: RuleCustomization[]): RuleSeverity | undefined {
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

type SaveRuleConfigItem = { offRules: Set<string>, onRules: Set<string>};
const saveRuleConfigCache = new LRUCache<string, SaveRuleConfigItem | null>(128);
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

async function getSaveRuleConfig(uri: string, settings: TextDocumentSettings  & { library: ESLintModule }): Promise<SaveRuleConfigItem | undefined> {
	const filePath = getFilePath(uri);
	let result = saveRuleConfigCache.get(uri);
	if (filePath === undefined || result === null) {
		return undefined;
	}
	if (result !== undefined) {
		return result;
	}
	const rules = settings.codeActionOnSave.rules;
	result = await withESLintClass(async (eslint) => {
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

function makeDiagnostic(settings: TextDocumentSettings, problem: ESLintProblem): [Diagnostic, RuleSeverity | undefined] {
	const message = problem.message;
	const startLine = typeof problem.line !== 'number' ? 0 : Math.max(0, problem.line - 1);
	const startChar = typeof problem.column !== 'number' ? 0 : Math.max(0, problem.column - 1);
	const endLine = typeof problem.endLine !== 'number' ? startLine : Math.max(0, problem.endLine - 1);
	const endChar = typeof problem.endColumn !== 'number' ? startChar : Math.max(0, problem.endColumn - 1);
	const override = getSeverityOverride(problem.ruleId, settings.rulesCustomizations);
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

interface Problem {
	label: string;
	documentVersion: number;
	ruleId: string;
	line: number;
	diagnostic: Diagnostic;
	edit?: ESLintAutoFixEdit;
	suggestions?: ESLintSuggestionResult[];
}

namespace Problem {
	export function isFixable(problem: Problem): problem is FixableProblem {
		return problem.edit !== undefined;
	}

	export function hasSuggestions(problem: Problem): problem is SuggestionsProblem {
		return problem.suggestions !== undefined;
	}
}

interface FixableProblem extends Problem {
	edit: ESLintAutoFixEdit;
}

namespace FixableProblem {
	export function createTextEdit(document: TextDocument, editInfo: FixableProblem): TextEdit {
		return TextEdit.replace(Range.create(document.positionAt(editInfo.edit.range[0]), document.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}
}

interface SuggestionsProblem extends Problem {
	suggestions: ESLintSuggestionResult[];
}

namespace SuggestionsProblem {
	export function createTextEdit(document: TextDocument, suggestion: ESLintSuggestionResult): TextEdit {
		return TextEdit.replace(Range.create(document.positionAt(suggestion.fix.range[0]), document.positionAt(suggestion.fix.range[1])), suggestion.fix.text || '');
	}
}

function computeKey(diagnostic: Diagnostic): string {
	const range = diagnostic.range;
	let message: string | undefined;
	if (diagnostic.message) {
		const hash  = crypto.createHash('md5');
		hash.update(diagnostic.message);
		message = hash.digest('base64');
	}
	return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}-${message ?? ''}`;
}

const codeActions: Map<string, Map<string, Problem>> = new Map<string, Map<string, Problem>>();
function recordCodeAction(document: TextDocument, diagnostic: Diagnostic, problem: ESLintProblem): void {
	if (!problem.ruleId) {
		return;
	}
	const uri = document.uri;
	let edits: Map<string, Problem> | undefined = codeActions.get(uri);
	if (edits === undefined) {
		edits = new Map<string, Problem>();
		codeActions.set(uri, edits);
	}
	edits.set(computeKey(diagnostic), {
		label: `Fix this ${problem.ruleId} problem`,
		documentVersion: document.version,
		ruleId: problem.ruleId,
		line: problem.line,
		diagnostic: diagnostic,
		edit: problem.fix,
		suggestions: problem.suggestions
	 });
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

const enum CharCode {
	/**
	 * The `\` character.
	 */
	Backslash = 92,
}

/**
 * Check if the path follows this pattern: `\\hostname\sharename`.
 *
 * @see https://msdn.microsoft.com/en-us/library/gg465305.aspx
 * @return A boolean indication if the path is a UNC path, on none-windows
 * always false.
 */
function isUNC(path: string): boolean {
	if (process.platform !== 'win32') {
		// UNC is a windows concept
		return false;
	}

	if (!path || path.length < 5) {
		// at least \\a\b
		return false;
	}

	let code = path.charCodeAt(0);
	if (code !== CharCode.Backslash) {
		return false;
	}
	code = path.charCodeAt(1);
	if (code !== CharCode.Backslash) {
		return false;
	}
	let pos = 2;
	const start = pos;
	for (; pos < path.length; pos++) {
		code = path.charCodeAt(pos);
		if (code === CharCode.Backslash) {
			break;
		}
	}
	if (start === pos) {
		return false;
	}
	code = path.charCodeAt(pos + 1);
	if (isNaN(code) || code === CharCode.Backslash) {
		return false;
	}
	return true;
}

function normalizeDriveLetter(path: string): string {
	if (process.platform !== 'win32' || path.length < 2 || path[1] !== ':') {
		return path;
	}
	return path[0].toUpperCase() + path.substr(1);
}

function getFileSystemPath(uri: URI): string {
	let result = uri.fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		result = result[0].toUpperCase() + result.substr(1);
	}
	if (process.platform === 'win32' || process.platform === 'darwin') {
		const realpath = fs.realpathSync.native(result);
		// Only use the real path if only the casing has changed.
		if (realpath.toLowerCase() === result.toLowerCase()) {
			result = realpath;
		}
	}
	return result;
}

function normalizePath(path: string): string;
function normalizePath(path: undefined): undefined;
function normalizePath(path: string | undefined): string | undefined {
	if (path === undefined) {
		return undefined;
	}
	if (process.platform === 'win32') {
		return path.replace(/\\/g, '/');
	}
	return path;
}

function getUri(documentOrUri: string | TextDocument | URI): URI {
	return Is.string(documentOrUri)
		? URI.parse(documentOrUri)
		: documentOrUri instanceof URI
			? documentOrUri
			: URI.parse(documentOrUri.uri);
}

function getFilePath(documentOrUri: string | TextDocument | URI | undefined): string | undefined {
	if (!documentOrUri) {
		return undefined;
	}
	const uri = getUri(documentOrUri);
	if (uri.scheme !== 'file') {
		return undefined;
	}
	return getFileSystemPath(uri);
}

const exitCalled = new NotificationType<[number, string]>('eslint/exitCalled');

const nodeExit = process.exit;
process.exit = ((code?: number): void => {
	const stack = new Error('stack');
	connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
	setTimeout(() => {
		nodeExit(code);
	}, 1000);
}) as any;
process.on('uncaughtException', (error: any) => {
	let message: string | undefined;
	if (error) {
		if (typeof error.stack === 'string') {
			message = error.stack;
		} else if (typeof error.message === 'string') {
			message = error.message;
		} else if (typeof error === 'string') {
			message = error;
		}
		if (message === undefined || message.length === 0) {
			try {
				message = JSON.stringify(error, undefined, 4);
			} catch (e) {
				// Should not happen.
			}
		}
	}
	// eslint-disable-next-line no-console
	console.error('Uncaught exception received.');
	if (message) {
		// eslint-disable-next-line no-console
		console.error(message);
	}
});


function isRequestMessage(message: LMessage | undefined): message is LRequestMessage {
	const candidate = <LRequestMessage>message;
	return candidate && typeof candidate.method === 'string' && (typeof candidate.id === 'string' || typeof candidate.id === 'number');
}

const connection = createConnection({
	cancelUndispatched: (message: LMessage) => {
		// Code actions can savely be cancel on request.
		if (isRequestMessage(message) && message.method === 'textDocument/codeAction') {
			const response: LResponseMessage = {
				jsonrpc: message.jsonrpc,
				id: message.id,
				result: null
			};
			return response;
		}
		return undefined;
	}
});
connection.console.info(`ESLint server running in node ${process.version}`);
// Is instantiated in the initialize handle;
let documents!: TextDocuments<TextDocument>;

const _globalPaths: Record<string, { cache: string | undefined; get(): string | undefined; }> = {
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

function globalPathGet(packageManager: PackageManagers): string | undefined {
	const pm = _globalPaths[packageManager];
	if (pm) {
		if (pm.cache === undefined) {
			pm.cache = pm.get();
		}
		return pm.cache;
	}
	return undefined;
}

type LanguageConfig = {
	ext: string;
	lineComment: string;
	blockComment: [string, string];
};

const languageId2Config: Map<string, LanguageConfig> = new Map([
	['javascript', { ext: 'js', lineComment: '//', blockComment: ['/*', '*/'] }],
	['javascriptreact', { ext: 'jsx', lineComment: '//', blockComment: ['/*', '*/'] }],
	['typescript', { ext: 'ts', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['typescriptreact', { ext: 'tsx', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['html', { ext: 'html', lineComment: '//', blockComment: ['/*', '*/'] }],
	['vue', { ext: 'vue', lineComment: '//', blockComment: ['/*', '*/'] }],
	['coffeescript', { ext: 'coffee', lineComment: '#', blockComment: ['###', '###'] }],
	['yaml', { ext: 'yaml', lineComment: '#', blockComment: ['#', ''] }],
	['graphql', { ext: 'graphql', lineComment: '#', blockComment: ['#', ''] }]
]);

function getLineComment(languageId: string): string {
	return languageId2Config.get(languageId)?.lineComment ?? '//';
}

function getBlockComment(languageId: string): [string, string] {
	return languageId2Config.get(languageId)?.blockComment ?? ['/**', '*/'];
}

const languageId2ParserRegExp: Map<string, RegExp[]> = function createLanguageId2ParserRegExp() {
	const result = new Map<string, RegExp[]>();
	const typescript = /\/@typescript-eslint\/parser\//;
	const babelESLint = /\/babel-eslint\/lib\/index.js$/;
	result.set('typescript', [typescript, babelESLint]);
	result.set('typescriptreact', [typescript, babelESLint]);

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

const path2Library: Map<string, ESLintModule> = new Map<string, ESLintModule>();
const document2Settings: Map<string, Promise<TextDocumentSettings>> = new Map<string, Promise<TextDocumentSettings>>();

const projectFolderIndicators: [string, boolean][] = [
	[ 'package.json',  true ],
	[ '.eslintignore', true],
	[ '.eslintrc', false ],
	[ '.eslintrc.json', false ],
	[ '.eslintrc.js', false ],
	[ '.eslintrc.yaml', false ],
	[ '.eslintrc.yml', false ]
];

function getESLintFilePath(document: TextDocument | undefined, settings: TextDocumentSettings): string | undefined {
	if (document === undefined) {
		return undefined;
	}
	const uri = URI.parse(document.uri);
	if (uri.scheme === 'untitled') {
		if (settings.workspaceFolder !== undefined) {
			const ext = languageId2Config.get(document.languageId);
			const workspacePath = getFilePath(settings.workspaceFolder.uri);
			if (workspacePath !== undefined && ext !== undefined) {
				return path.join(workspacePath, `test${ext}`);
			}
		}
		return undefined;
	} else {
		return getFilePath(uri);
	}
}

function findWorkingDirectory(workspaceFolder: string, file: string | undefined): string | undefined {
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
		for (const item of projectFolderIndicators) {
			if (fs.existsSync(path.join(directory, item[0]))) {
				result = directory;
				if (item[1]) {
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

function resolveSettings(document: TextDocument): Promise<TextDocumentSettings> {
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
		settings.resolvedGlobalPackageManagerPath = globalPathGet(settings.packageManager);
		const filePath = getFilePath(document);
		const workspaceFolderPath = settings.workspaceFolder !== undefined ? getFilePath(settings.workspaceFolder.uri) : undefined;
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
		if (nodePath !== undefined) {
			promise = Files.resolve('eslint', nodePath, nodePath, trace).then<string, string>(undefined, () => {
				return Files.resolve('eslint', settings.resolvedGlobalPackageManagerPath, moduleResolveWorkingDirectory, trace);
			});
		} else {
			promise = Files.resolve('eslint', settings.resolvedGlobalPackageManagerPath, moduleResolveWorkingDirectory, trace);
		}

		settings.silent = settings.validate === Validate.probe;
		return promise.then(async (libraryPath) => {
			let library = path2Library.get(libraryPath);
			if (library === undefined) {
				library = loadNodeModule(libraryPath);
				if (library === undefined) {
					settings.validate = Validate.off;
					if (!settings.silent) {
						connection.console.error(`Failed to load eslint library from ${libraryPath}. See output panel for more information.`);
					}
				} else if (library.CLIEngine === undefined && library.ESLint === undefined) {
					settings.validate = Validate.off;
					connection.console.error(`The eslint library loaded from ${libraryPath} doesn\'t neither exports a CLIEngine nor an ESLint class. You need at least eslint@1.0.0`);
				} else {
					connection.console.info(`ESLint library loaded from: ${libraryPath}`);
					settings.library = library;
					path2Library.set(libraryPath, library);
				}
			} else {
				settings.library = library;
			}
			if (settings.validate === Validate.probe && TextDocumentSettings.hasLibrary(settings)) {
				settings.validate = Validate.off;
				let filePath = getESLintFilePath(document, settings);
				if (filePath !== undefined) {
					const parserRegExps = languageId2ParserRegExp.get(document.languageId);
					const pluginName = languageId2PluginName.get(document.languageId);
					const parserOptions = languageId2ParserOptions.get(document.languageId);
					if (defaultLanguageIds.has(document.languageId)) {
						settings.validate = Validate.on;
					} else if (parserRegExps !== undefined || pluginName !== undefined || parserOptions !== undefined) {
						const eslintConfig: ESLintConfig | undefined = await withESLintClass((eslintClass) => {
							try {
								return eslintClass.calculateConfigForFile(filePath!);
							} catch (err) {
								return undefined;
							}
						}, settings);
						if (eslintConfig !== undefined) {
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
				if (settings.validate === Validate.off) {
					const params: ProbeFailedParams = { textDocument: { uri: document.uri } };
					void connection.sendRequest(ProbeFailedRequest.type, params);
				}
			}
			if (settings.format && settings.validate === Validate.on && TextDocumentSettings.hasLibrary(settings)) {
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
					const filePath = getFilePath(uri)!;
					await withESLintClass(async (eslintClass) => {
						if (!await eslintClass.isPathIgnored(filePath)) {
							formatterRegistrations.set(uri, connection.client.register(DocumentFormattingRequest.type, options));
						}
					}, settings);
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

interface Request<P, R> {
	method: string;
	params: P;
	documentVersion: number | undefined;
	resolve: (value: R | Promise<R>) => void | undefined;
	reject: (error: any) => void | undefined;
	token: CancellationToken;
}

namespace Request {
	export function is(value: any): value is Request<any, any> {
		const candidate: Request<any, any> = value;
		return candidate && candidate.token !== undefined && candidate.resolve !== undefined && candidate.reject !== undefined;
	}
}

interface Notification<P> {
	method: string;
	params: P;
	documentVersion: number | undefined;
}

type Message<P, R> = Notification<P> | Request<P, R>;

interface VersionProvider<P> {
	(params: P): number | undefined;
}

namespace Thenable {
	export function is<T>(value: any): value is Thenable<T> {
		const candidate: Thenable<T> = value;
		return candidate && typeof candidate.then === 'function';
	}
}

class BufferedMessageQueue {

	private queue: Message<any, any>[];
	private requestHandlers: Map<string, { handler: RequestHandler<any, any, any>, versionProvider?: VersionProvider<any> }>;
	private notificationHandlers: Map<string, { handler: NotificationHandler<any>, versionProvider?: VersionProvider<any> }>;
	private timer: NodeJS.Immediate | undefined;

	constructor(private connection: Connection) {
		this.queue = [];
		this.requestHandlers = new Map();
		this.notificationHandlers = new Map();
	}

	public registerRequest<P, R, E>(type: RequestType<P, R, E>, handler: RequestHandler<P, R, E>, versionProvider?: VersionProvider<P>): void {
		this.connection.onRequest(type, (params, token) => {
			return new Promise<R>((resolve, reject) => {
				this.queue.push({
					method: type.method,
					params: params,
					documentVersion: versionProvider ? versionProvider(params) : undefined,
					resolve: resolve,
					reject: reject,
					token: token
				});
				this.trigger();
			});
		});
		this.requestHandlers.set(type.method, { handler, versionProvider });
	}

	public registerNotification<P>(type: NotificationType<P>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
		connection.onNotification(type, (params) => {
			this.queue.push({
				method: type.method,
				params: params,
				documentVersion: versionProvider ? versionProvider(params) : undefined,
			});
			this.trigger();
		});
		this.notificationHandlers.set(type.method, { handler, versionProvider });
	}

	public addNotificationMessage<P>(type: NotificationType<P>, params: P, version: number) {
		this.queue.push({
			method: type.method,
			params,
			documentVersion: version
		});
		this.trigger();
	}

	public onNotification<P>(type: NotificationType<P>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
		this.notificationHandlers.set(type.method, { handler, versionProvider });
	}

	private trigger(): void {
		if (this.timer || this.queue.length === 0) {
			return;
		}
		this.timer = setImmediate(() => {
			this.timer = undefined;
			this.processQueue();
			this.trigger();
		});
	}

	private processQueue(): void {
		const message = this.queue.shift();
		if (!message) {
			return;
		}
		if (Request.is(message)) {
			const requestMessage = message;
			if (requestMessage.token.isCancellationRequested) {
				requestMessage.reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request got cancelled'));
				return;
			}
			const elem = this.requestHandlers.get(requestMessage.method);
			if (elem === undefined) {
				throw new Error(`No handler registered`);
			}
			if (elem.versionProvider && requestMessage.documentVersion !== undefined && requestMessage.documentVersion !== elem.versionProvider(requestMessage.params)) {
				requestMessage.reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request got cancelled'));
				return;
			}
			const result = elem.handler(requestMessage.params, requestMessage.token);
			if (Thenable.is(result)) {
				result.then((value) => {
					requestMessage.resolve(value);
				}, (error) => {
					requestMessage.reject(error);
				});
			} else {
				requestMessage.resolve(result);
			}
		} else {
			const notificationMessage = message;
			const elem = this.notificationHandlers.get(notificationMessage.method);
			if (elem === undefined) {
				throw new Error(`No handler registered`);
			}
			if (elem.versionProvider && notificationMessage.documentVersion !== undefined && notificationMessage.documentVersion !== elem.versionProvider(notificationMessage.params)) {
				return;
			}
			elem.handler(notificationMessage.params);
		}
	}
}

const messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection);
const formatterRegistrations: Map<string, Promise<Disposable>> = new Map();

namespace ValidateNotification {
	export const type: NotificationType<TextDocument> = new NotificationType<TextDocument>('eslint/validate');
}

messageQueue.onNotification(ValidateNotification.type, (document) => {
	void validateSingle(document, true);
}, (document): number => {
	return document.version;
});

function setupDocumentsListeners() {
	// The documents manager listen for text document create, change
	// and close on the connection
	documents.listen(connection);
	documents.onDidOpen((event) => {
		void resolveSettings(event.document).then((settings) => {
			if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings)) {
				return;
			}
			if (settings.run === 'onSave') {
				messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
			}
		});
	});

	// A text document has changed. Validate the document according the run setting.
	documents.onDidChangeContent((event) => {
		const uri = event.document.uri;
		codeActions.delete(uri);
		void resolveSettings(event.document).then((settings) => {
			if (settings.validate !== Validate.on || settings.run !== 'onType') {
				return;
			}
			messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
		});
	});

	// A text document has been saved. Validate the document according the run setting.
	documents.onDidSave((event) => {
		void resolveSettings(event.document).then((settings) => {
			if (settings.validate !== Validate.on || settings.run !== 'onSave') {
				return;
			}
			messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
		});
	});

	documents.onDidClose((event) => {
		void resolveSettings(event.document).then((settings) => {
			const uri = event.document.uri;
			document2Settings.delete(uri);
			saveRuleConfigCache.delete(uri);
			codeActions.delete(uri);
			const unregister = formatterRegistrations.get(event.document.uri);
			if (unregister !== undefined) {
				void unregister.then(disposable => disposable.dispose());
				formatterRegistrations.delete(event.document.uri);
			}
			if (settings.validate === Validate.on) {
				connection.sendDiagnostics({ uri: uri, diagnostics: [] });
			}
		});
	});
}

function environmentChanged() {
	document2Settings.clear();
	ruleSeverityCache.clear();
	saveRuleConfigCache.clear();

	for (const document of documents.all()) {
		messageQueue.addNotificationMessage(ValidateNotification.type, document, document.version);
	}
	for (const unregistration of formatterRegistrations.values()) {
		void unregistration.then(disposable => disposable.dispose());
	}
	formatterRegistrations.clear();
}

function trace(message: string, verbose?: string): void {
	connection.tracer.log(message, verbose);
}

connection.onInitialize((_params, _cancel, progress) => {
	progress.begin('Initializing ESLint Server');
	const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Incremental;
	documents = new TextDocuments(TextDocument);
	setupDocumentsListeners();
	progress.done();
	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: syncKind,
				willSaveWaitUntil: false,
				save: {
					includeText: false
				}
			},
			workspace: {
				workspaceFolders: {
					supported: true
				}
			},
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, `${CodeActionKind.SourceFixAll}.eslint`] },
			executeCommandProvider: {
				commands: [
					CommandIds.applySingleFix,
					CommandIds.applySuggestion,
					CommandIds.applySameFixes,
					CommandIds.applyAllFixes,
					CommandIds.applyDisableLine,
					CommandIds.applyDisableFile,
					CommandIds.openRuleDoc,
				]
			}
		}
	};
});

connection.onInitialized(() => {
	void connection.client.register(DidChangeConfigurationNotification.type, undefined);
	void connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined);
});

messageQueue.registerNotification(DidChangeConfigurationNotification.type, (_params) => {
	environmentChanged();
});

messageQueue.registerNotification(DidChangeWorkspaceFoldersNotification.type, (_params) => {
	environmentChanged();
});

const singleErrorHandlers: ((error: any, document: TextDocument, library: ESLintModule) => Status | undefined)[] = [
	tryHandleNoConfig,
	tryHandleConfigError,
	tryHandleMissingModule,
	showErrorMessage
];

function validateSingle(document: TextDocument, publishDiagnostics: boolean = true): Promise<void> {
	// We validate document in a queue but open / close documents directly. So we need to deal with the
	// fact that a document might be gone from the server.
	if (!documents.get(document.uri)) {
		return Promise.resolve(undefined);
	}
	return resolveSettings(document).then(async (settings) => {
		if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings)) {
			return;
		}
		try {
			await validate(document, settings, publishDiagnostics);
			connection.sendNotification(StatusNotification.type, { uri: document.uri, state: Status.ok });
		} catch (err) {
			// if an exception has occurred while validating clear all errors to ensure
			// we are not showing any stale once
			connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
			if (!settings.silent) {
				let status: Status | undefined = undefined;
				for (const handler of singleErrorHandlers) {
					status = handler(err, document, settings.library);
					if (status) {
						break;
					}
				}
				status = status || Status.error;
				connection.sendNotification(StatusNotification.type, { uri: document.uri, state: status });
			} else {
				connection.console.info(getMessage(err, document));
				connection.sendNotification(StatusNotification.type, { uri: document.uri, state: Status.ok });
			}
		}
	});
}

function validateMany(documents: TextDocument[]): void {
	documents.forEach(document => {
		messageQueue.addNotificationMessage(ValidateNotification.type, document, document.version);
	});
}

function getMessage(err: any, document: TextDocument): string {
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

const validFixTypes = new Set<string>(['problem', 'suggestion', 'layout']);
async function validate(document: TextDocument, settings: TextDocumentSettings & { library: ESLintModule }, publishDiagnostics: boolean = true): Promise<void> {
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
	const file = getESLintFilePath(document, settings);

	await withESLintClass(async (eslintClass) => {
		codeActions.delete(uri);
		const reportResults: ESLintDocumentReport[] = await eslintClass.lintText(content, { filePath: file, warnIgnored: settings.onIgnoredFiles !== ESLintSeverity.off });
		RuleMetaData.capture(eslintClass, reportResults);
		const diagnostics: Diagnostic[] = [];
		if (reportResults && Array.isArray(reportResults) && reportResults.length > 0) {
			const docReport = reportResults[0];
			if (docReport.messages && Array.isArray(docReport.messages)) {
				docReport.messages.forEach((problem) => {
					if (problem) {
						const [diagnostic, override] = makeDiagnostic(settings, problem);
						if (!(override === RuleSeverity.off || (settings.quiet && diagnostic.severity === DiagnosticSeverity.Warning))) {
							diagnostics.push(diagnostic);
						}
						if (fixTypes !== undefined && problem.ruleId !== undefined && problem.fix !== undefined) {
							const type = RuleMetaData.getType(problem.ruleId);
							if (type !== undefined && fixTypes.has(type)) {
								recordCodeAction(document, diagnostic, problem);
							}
						} else {
							recordCodeAction(document, diagnostic, problem);
						}
					}
				});
			}
		}
		if (publishDiagnostics) {
			connection.sendDiagnostics({ uri, diagnostics });
		}
	}, settings);
}

function withESLintClass<T>(func: (eslintClass: ESLintClass) => T, settings: TextDocumentSettings & { library: ESLintModule }, options?: ESLintClassOptions | CLIOptions): T {
	const newOptions: ESLintClassOptions | CLIOptions = options === undefined
		? Object.assign(Object.create(null), settings.options)
		: Object.assign(Object.create(null), settings.options, options);

	const cwd = process.cwd();
	try {
		if (settings.workingDirectory) {
			newOptions.cwd = normalizeDriveLetter(settings.workingDirectory.directory);
			if (settings.workingDirectory['!cwd'] !== true && fs.existsSync(settings.workingDirectory.directory)) {
				process.chdir(settings.workingDirectory.directory);
			}
		}

		const eslintClass = ESLintClass.newESLintClass(settings.library, newOptions, settings.useESLintClass);
		return func(eslintClass);
	} finally {
		if (cwd !== process.cwd()) {
			process.chdir(cwd);
		}
	}
}

const noConfigReported: Map<string, ESLintModule> = new Map<string, ESLintModule>();

function isNoConfigFoundError(error: any): boolean {
	const candidate = error as ESLintError;
	return candidate.messageTemplate === 'no-config-found' || candidate.message === 'No ESLint configuration found.';
}

function tryHandleNoConfig(error: any, document: TextDocument, library: ESLintModule): Status | undefined {
	if (!isNoConfigFoundError(error)) {
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

function tryHandleMissingModule(error: any, document: TextDocument, library: ESLintModule): Status | undefined {
	if (!error.message) {
		return undefined;
	}

	function handleMissingModule(plugin: string, module: string, error: ESLintError): Status {
		if (!missingModuleReported.has(plugin)) {
			const fsPath = getFilePath(document);
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
	void connection.window.showErrorMessage(`ESLint: ${getMessage(error, document)}. Please see the 'ESLint' output channel for details.`, { title: 'Open Output', id: 1}).then((value) => {
		if (value !== undefined && value.id === 1) {
			connection.sendNotification(ShowOutputChannel.type);
		}
	});
	if (Is.string(error.stack)) {
		connection.console.error('ESLint stack trace:');
		connection.console.error(error.stack);
	}
	return Status.error;
}

messageQueue.registerNotification(DidChangeWatchedFilesNotification.type, async (params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	RuleMetaData.clear();
	noConfigReported.clear();
	missingModuleReported.clear();
	document2Settings.clear(); // config files can change plugins and parser.
	ruleSeverityCache.clear();
	saveRuleConfigCache.clear();

	await Promise.all(params.changes.map(async (change) => {
		const fsPath = getFilePath(change.uri);
		if (fsPath === undefined || fsPath.length === 0 || isUNC(fsPath)) {
			return;
		}
		const dirname = path.dirname(fsPath);
		if (dirname) {
			const library = configErrorReported.get(fsPath);
			if (library !== undefined) {
				const eslintClass = ESLintClass.newESLintClass(library, {}, false);
				try {
					await eslintClass.lintText('', { filePath: path.join(dirname, '___test___.js') });
					configErrorReported.delete(fsPath);
				} catch (error) {
				}
			}
		}
	}));
	validateMany(documents.all());
});

class Fixes {
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
			const key = computeKey(diagnostic);
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

interface RuleCodeActions {
	fixes: CodeAction[];
	suggestions: CodeAction[];
	disable?: CodeAction;
	fixAll?: CodeAction;
	disableFile?: CodeAction;
	showDocumentation?: CodeAction;
}

class CodeActionResult {
	private _actions: Map<string, RuleCodeActions>;
	private _fixAll: CodeAction[] | undefined;

	public constructor() {
		this._actions = new Map();
	}

	public get(ruleId: string): RuleCodeActions {
		let result: RuleCodeActions | undefined = this._actions.get(ruleId);
		if (result === undefined) {
			result = { fixes: [], suggestions: [] };
			this._actions.set(ruleId, result);
		}
		return result;
	}

	public get fixAll() {
		if (this._fixAll === undefined) {
			this._fixAll = [];
		}
		return this._fixAll;
	}

	public all(): CodeAction[] {
		const result: CodeAction[] = [];
		for (const actions of this._actions.values()) {
			result.push(...actions.fixes);
			result.push(...actions.suggestions);
			if (actions.disable) {
				result.push(actions.disable);
			}
			if (actions.fixAll) {
				result.push(actions.fixAll);
			}
			if (actions.disableFile) {
				result.push(actions.disableFile);
			}
			if (actions.showDocumentation) {
				result.push(actions.showDocumentation);
			}
		}
		if (this._fixAll !== undefined) {
			result.push(...this._fixAll);
		}
		return result;
	}

	public get length(): number {
		let result: number = 0;
		for (const actions of this._actions.values()) {
			result += actions.fixes.length;
		}
		return result;
	}
}

class Changes {

	private readonly values: Map<string, WorkspaceChange>;
	private uri: string | undefined;
	private version: number | undefined;

	constructor() {
		this.values = new Map();
		this.uri = undefined;
		this.version = undefined;
	}

	public clear(textDocument?: TextDocument): void {
		if (textDocument === undefined) {
			this.uri = undefined;
			this.version = undefined;
		} else {
			this.uri = textDocument.uri;
			this.version = textDocument.version;
		}
		this.values.clear();
	}

	public isUsable(uri: string, version: number): boolean {
		return this.uri === uri && this.version === version;
	}

	public set(key: string, change: WorkspaceChange): void {
		this.values.set(key, change);
	}

	public get(key: string): WorkspaceChange | undefined {
		return this.values.get(key);
	}
}

interface CommandParams extends VersionedTextDocumentIdentifier {
	version: number;
	ruleId?: string;
	sequence?: number;
}

namespace CommandParams {
	export function create(textDocument: TextDocument, ruleId?: string, sequence?: number): CommandParams {
		return { uri: textDocument.uri, version: textDocument.version, ruleId, sequence };
	}
	export function hasRuleId(value: CommandParams): value is CommandParams & { ruleId: string } {
		return value.ruleId !== undefined;
	}
}

const changes = new Changes();
const ESLintSourceFixAll: string = `${CodeActionKind.SourceFixAll}.eslint`;

messageQueue.registerRequest(CodeActionRequest.type, (params) => {
	const result: CodeActionResult = new CodeActionResult();
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (textDocument === undefined) {
		changes.clear(textDocument);
		return result.all();
	}

	function createCodeAction(title: string, kind: string, commandId: string, arg: CommandParams, diagnostic?: Diagnostic): CodeAction {
		const command = Command.create(title, commandId, arg);
		const action = CodeAction.create(
			title,
			command,
			kind
		);
		if (diagnostic !== undefined) {
			action.diagnostics = [diagnostic];
		}
		return action;
	}


	function createDisableLineTextEdit(textDocument: TextDocument, editInfo: Problem, indentationText: string): TextEdit {
		// if the concerned line is not the first  line of the file
		if ( editInfo.line - 1 > 0) {

			// check previous line if there is a eslint-disable-next-line comment already present
			const prevLine = textDocument.getText(Range.create(Position.create(editInfo.line - 2, 0), Position.create(editInfo.line - 2, uinteger.MAX_VALUE)));
			const matched = prevLine && prevLine.match(new RegExp(`${getLineComment(textDocument.languageId)} eslint-disable-next-line`));
			if (matched && matched.length) {
				return TextEdit.insert(Position.create(editInfo.line - 2, uinteger.MAX_VALUE), `, ${editInfo.ruleId}`);
			}

		}
		return TextEdit.insert(Position.create(editInfo.line - 1, 0), `${indentationText}${getLineComment(textDocument.languageId)} eslint-disable-next-line ${editInfo.ruleId}${EOL}`);
	}

	function createDisableSameLineTextEdit(textDocument: TextDocument, editInfo: Problem): TextEdit {
		const currentLine = textDocument.getText(Range.create(Position.create(editInfo.line - 1, 0), Position.create(editInfo.line -1, uinteger.MAX_VALUE)));
		const matched = currentLine && new RegExp(`${getLineComment(textDocument.languageId)} eslint-disable-line`).exec(currentLine);

		const disableRuleContent = (matched && matched.length) ? `, ${editInfo.ruleId}` : ` ${getLineComment(textDocument.languageId)} eslint-disable-line ${editInfo.ruleId}`;

		return TextEdit.insert(Position.create(editInfo.line - 1, uinteger.MAX_VALUE), disableRuleContent);
	}

	function createDisableFileTextEdit(textDocument: TextDocument, editInfo: Problem): TextEdit {
		// If first line contains a shebang, insert on the next line instead.
		const shebang = textDocument.getText(Range.create(Position.create(0, 0), Position.create(0, 2)));
		const line = shebang === '#!' ? 1 : 0;
		const block = getBlockComment(textDocument.languageId);
		return TextEdit.insert(Position.create(line, 0), `${block[0]} eslint-disable ${editInfo.ruleId} ${block[1]}${EOL}`);
	}

	function getLastEdit(array: FixableProblem[]): FixableProblem | undefined {
		const length = array.length;
		if (length === 0) {
			return undefined;
		}
		return array[length - 1];
	}

	return resolveSettings(textDocument).then(async (settings): Promise<CodeAction[]> => {
		// The file is not validated at all or we couldn't load an eslint library for it.
		if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings)) {
			return result.all();
		}

		const problems = codeActions.get(uri);
		// We validate on type and have no problems ==> nothing to fix.
		if (problems === undefined && settings.run === 'onType') {
			return result.all();
		}

		const only: string | undefined = params.context.only !== undefined && params.context.only.length > 0 ? params.context.only[0] : undefined;
		const isSource = only === CodeActionKind.Source;
		const isSourceFixAll = (only === ESLintSourceFixAll || only === CodeActionKind.SourceFixAll);
		if (isSourceFixAll || isSource) {
			if (isSourceFixAll && settings.codeActionOnSave.enable) {
				const textDocumentIdentifer: VersionedTextDocumentIdentifier = { uri: textDocument.uri, version: textDocument.version };
				const edits = await computeAllFixes(textDocumentIdentifer, AllFixesMode.onSave);
				if (edits !== undefined) {
					result.fixAll.push(CodeAction.create(
						`Fix all ESLint auto-fixable problems`,
						{ documentChanges: [ TextDocumentEdit.create(textDocumentIdentifer, edits )]},
						ESLintSourceFixAll
					));
				}
			} else if (isSource) {
				result.fixAll.push(createCodeAction(
					`Fix all ESLint auto-fixable problems`,
					CodeActionKind.Source,
					CommandIds.applyAllFixes,
					CommandParams.create(textDocument)
				));
			}
			return result.all();
		}

		if (problems === undefined) {
			return result.all();
		}

		const fixes = new Fixes(problems);
		if (fixes.isEmpty()) {
			return result.all();
		}

		let documentVersion: number = -1;
		const allFixableRuleIds: string[] = [];
		const kind: CodeActionKind = only ?? CodeActionKind.QuickFix;

		for (const editInfo of fixes.getScoped(params.context.diagnostics)) {
			documentVersion = editInfo.documentVersion;
			const ruleId = editInfo.ruleId;
			allFixableRuleIds.push(ruleId);

			if (Problem.isFixable(editInfo)) {
				const workspaceChange = new WorkspaceChange();
				workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(FixableProblem.createTextEdit(textDocument, editInfo));
				changes.set(`${CommandIds.applySingleFix}:${ruleId}`, workspaceChange);
				const action = createCodeAction(
					editInfo.label,
					kind,
					CommandIds.applySingleFix,
					CommandParams.create(textDocument, ruleId),
					editInfo.diagnostic
				);
				action.isPreferred = true;
				result.get(ruleId).fixes.push(action);
			}
			if (Problem.hasSuggestions(editInfo)) {
				editInfo.suggestions.forEach((suggestion, suggestionSequence) => {
					const workspaceChange = new WorkspaceChange();
					workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(SuggestionsProblem.createTextEdit(textDocument, suggestion));
					changes.set(`${CommandIds.applySuggestion}:${ruleId}:${suggestionSequence}`, workspaceChange);
					const action = createCodeAction(
						`${suggestion.desc} (${editInfo.ruleId})`,
						CodeActionKind.QuickFix,
						CommandIds.applySuggestion,
						CommandParams.create(textDocument, ruleId, suggestionSequence),
						editInfo.diagnostic
					);
					result.get(ruleId).suggestions.push(action);
				});
			}

			if (settings.codeAction.disableRuleComment.enable) {
				let workspaceChange = new WorkspaceChange();
				if (settings.codeAction.disableRuleComment.location === 'sameLine') {
					workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(createDisableSameLineTextEdit(textDocument, editInfo));
				} else {
					const lineText = textDocument.getText(Range.create(Position.create(editInfo.line - 1, 0), Position.create(editInfo.line - 1, uinteger.MAX_VALUE)));
					const matches = /^([ \t]*)/.exec(lineText);
					const indentationText = matches !== null && matches.length > 0 ? matches[1] : '';
					workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(createDisableLineTextEdit(textDocument, editInfo, indentationText));
				}
				changes.set(`${CommandIds.applyDisableLine}:${ruleId}`, workspaceChange);
				result.get(ruleId).disable = createCodeAction(
					`Disable ${ruleId} for this line`,
					kind,
					CommandIds.applyDisableLine,
					CommandParams.create(textDocument, ruleId)
				);

				if (result.get(ruleId).disableFile === undefined) {
					workspaceChange = new WorkspaceChange();
					workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(createDisableFileTextEdit(textDocument, editInfo));
					changes.set(`${CommandIds.applyDisableFile}:${ruleId}`, workspaceChange);
					result.get(ruleId).disableFile = createCodeAction(
						`Disable ${ruleId} for the entire file`,
						kind,
						CommandIds.applyDisableFile,
						CommandParams.create(textDocument, ruleId)
					);
				}
			}

			if (settings.codeAction.showDocumentation.enable && result.get(ruleId).showDocumentation === undefined) {
				if (RuleMetaData.hasRuleId(ruleId)) {
					result.get(ruleId).showDocumentation = createCodeAction(
						`Show documentation for ${ruleId}`,
						kind,
						CommandIds.openRuleDoc,
						CommandParams.create(textDocument, ruleId)
					);
				}
			}
		}

		if (result.length > 0) {
			const sameProblems: Map<string, FixableProblem[]> = new Map<string, FixableProblem[]>(allFixableRuleIds.map<[string, FixableProblem[]]>(s => [s, []]));

			for (const editInfo of fixes.getAllSorted()) {
				if (documentVersion === -1) {
					documentVersion = editInfo.documentVersion;
				}
				if (sameProblems.has(editInfo.ruleId)) {
					const same = sameProblems.get(editInfo.ruleId)!;
					if (!Fixes.overlaps(getLastEdit(same), editInfo)) {
						same.push(editInfo);
					}
				}
			}
			sameProblems.forEach((same, ruleId) => {
				if (same.length > 1) {
					const sameFixes: WorkspaceChange = new WorkspaceChange();
					const sameTextChange = sameFixes.getTextEditChange({ uri, version: documentVersion });
					same.map(fix => FixableProblem.createTextEdit(textDocument, fix)).forEach(edit => sameTextChange.add(edit));
					changes.set(CommandIds.applySameFixes, sameFixes);
					result.get(ruleId).fixAll = createCodeAction(
						`Fix all ${ruleId} problems`,
						kind,
						CommandIds.applySameFixes,
						CommandParams.create(textDocument)
					);
				}
			});
			result.fixAll.push(createCodeAction(
				`Fix all auto-fixable problems`,
				kind,
				CommandIds.applyAllFixes,
				CommandParams.create(textDocument)
			));
		}
		return result.all();
	});
}, (params): number | undefined => {
	const document = documents.get(params.textDocument.uri);
	return document !== undefined ? document.version : undefined;
});

enum AllFixesMode {
	onSave = 'onsave',
	format = 'format',
	command = 'command'
}

async function computeAllFixes(identifier: VersionedTextDocumentIdentifier, mode: AllFixesMode): Promise<TextEdit[] | undefined> {
	const uri = identifier.uri;
	const textDocument = documents.get(uri)!;
	if (textDocument === undefined || identifier.version !== textDocument.version) {
		return undefined;
	}

	const settings = await resolveSettings(textDocument);

	if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings) || (mode === AllFixesMode.format && !settings.format)) {
		return [];
	}
	const filePath = getFilePath(textDocument);
	const problems = codeActions.get(uri);
	const originalContent = textDocument.getText();
	let start = Date.now();
	// Only use known fixes when running in onSave mode. See https://github.com/microsoft/vscode-eslint/issues/871
	// for details
	if (mode === AllFixesMode.onSave && settings.codeActionOnSave.mode === CodeActionsOnSaveMode.problems) {
		const result = problems !== undefined && problems.size > 0
			? new Fixes(problems).getApplicable().map(fix => FixableProblem.createTextEdit(textDocument, fix))
			: [];
		connection.tracer.log(`Computing all fixes took: ${Date.now() - start} ms.`);
		return result;
	} else {
		const saveConfig = filePath !== undefined && mode === AllFixesMode.onSave ? await getSaveRuleConfig(uri, settings) : undefined;
		const offRules = saveConfig?.offRules;
		const onRules = saveConfig?.onRules;
		let overrideConfig: Required<ConfigData> | undefined;
		if (offRules !== undefined) {
			overrideConfig = { rules: Object.create(null) };
			for (const ruleId of offRules) {
				overrideConfig.rules[ruleId] = 'off';
			}
		}
		return withESLintClass(async (eslintClass) => {
			const result: TextEdit[] = [];
			let fixes: TextEdit[] | undefined;
			if (problems !== undefined && problems.size > 0) {
				// We have override rules that turn rules off. Filter the fixes for these rules.
				if (offRules !== undefined) {
					const filtered: typeof problems = new Map();
					for (const [key, problem] of problems) {
						if (onRules?.has(problem.ruleId)) {
							filtered.set(key, problem);
						}
					}
					fixes = filtered.size > 0 ? new Fixes(filtered).getApplicable().map(fix => FixableProblem.createTextEdit(textDocument, fix)) : undefined;
				} else {
					fixes = new Fixes(problems).getApplicable().map(fix => FixableProblem.createTextEdit(textDocument, fix));
				}
			}
			const content = fixes !== undefined
				? TextDocument.applyEdits(textDocument, fixes)
				: originalContent;
			const reportResults = await eslintClass.lintText(content, { filePath });
			connection.tracer.log(`Computing all fixes took: ${Date.now() - start} ms.`);
			if (Array.isArray(reportResults) && reportResults.length === 1 && reportResults[0].output !== undefined) {
				const fixedContent = reportResults[0].output;
				start = Date.now();
				const diffs = stringDiff(originalContent, fixedContent, false);
				connection.tracer.log(`Computing minimal edits took: ${Date.now() - start} ms.`);
				for (const diff of diffs) {
					result.push({
						range: {
							start: textDocument.positionAt(diff.originalStart),
							end: textDocument.positionAt(diff.originalStart + diff.originalLength)
						},
						newText: fixedContent.substr(diff.modifiedStart, diff.modifiedLength)
					});
				}
			} else if (fixes !== undefined) {
				result.push(...fixes);
			}
			return result;
		}, settings, overrideConfig !== undefined ? { fix: true, overrideConfig } : { fix: true });
	}
}

messageQueue.registerRequest(ExecuteCommandRequest.type, async (params) => {
	let workspaceChange: WorkspaceChange | undefined;
	const commandParams: CommandParams = params.arguments![0] as CommandParams;
	if (params.command === CommandIds.applyAllFixes) {
		const edits = await computeAllFixes(commandParams, AllFixesMode.command);
		if (edits !== undefined) {
			workspaceChange = new WorkspaceChange();
			const textChange = workspaceChange.getTextEditChange(commandParams);
			edits.forEach(edit => textChange.add(edit));
		}
	} else {
		if ([CommandIds.applySingleFix, CommandIds.applyDisableLine, CommandIds.applyDisableFile].indexOf(params.command) !== -1) {
			workspaceChange = changes.get(`${params.command}:${commandParams.ruleId}`);
		} else if ([CommandIds.applySuggestion].indexOf(params.command) !== -1) {
			workspaceChange = changes.get(`${params.command}:${commandParams.ruleId}:${commandParams.sequence}`);
		} else if (params.command === CommandIds.openRuleDoc && CommandParams.hasRuleId(commandParams)) {
			const url = RuleMetaData.getUrl(commandParams.ruleId);
			if (url) {
				void connection.sendRequest(OpenESLintDocRequest.type, { url });
			}
		} else {
			workspaceChange = changes.get(params.command);
		}
	}

	if (workspaceChange === undefined) {
		return {};
	}
	return connection.workspace.applyEdit(workspaceChange.edit).then((response) => {
		if (!response.applied) {
			connection.console.error(`Failed to apply command: ${params.command}`);
		}
		return {};
	}, () => {
		connection.console.error(`Failed to apply command: ${params.command}`);
	});
}, (params): number | undefined => {
	const commandParam: CommandParams = params.arguments![0] as CommandParams;
	if (changes.isUsable(commandParam.uri, commandParam.version)) {
		return commandParam.version;
	} else {
		return undefined;
	}
});


messageQueue.registerRequest(DocumentFormattingRequest.type, (params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (textDocument === undefined) {
		return [];
	}
	return computeAllFixes({ uri: textDocument.uri, version: textDocument.version }, AllFixesMode.format);
}, (params) => {
	const document = documents.get(params.textDocument.uri);
	return document !== undefined ? document.version : undefined;
});
connection.listen();
