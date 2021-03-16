/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, NotificationType, ErrorCodes,
	RequestHandler, NotificationHandler,
	Diagnostic, DiagnosticSeverity, Range, Files, CancellationToken,
	TextDocuments, TextDocumentSyncKind, TextEdit, TextDocumentIdentifier, TextDocumentSaveReason,
	Command, WorkspaceChange,
	CodeActionRequest, VersionedTextDocumentIdentifier,
	ExecuteCommandRequest, DidChangeWatchedFilesNotification, DidChangeConfigurationNotification,
	WorkspaceFolder, DidChangeWorkspaceFoldersNotification, CodeAction, CodeActionKind, Position, DocumentFormattingRequest, DocumentFormattingRegistrationOptions, Disposable, DocumentFilter
} from 'vscode-languageserver';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { URI } from 'vscode-uri';
import * as path from 'path';
import { execSync } from 'child_process';
import { EOL } from 'os';
import { stringDiff } from './diff';

// import { stringDiff } from './diff';

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

type RunValues = 'onType' | 'onSave';

interface DirectoryItem {
	directory: string;
	changeProcessCWD?: boolean;
}

namespace DirectoryItem {
	export function is(item: any): item is DirectoryItem {
		const candidate = item as DirectoryItem;
		return candidate && Is.string(candidate.directory) && (Is.boolean(candidate.changeProcessCWD) || candidate.changeProcessCWD === undefined);
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
interface TextDocumentSettings {
	validate: boolean;
	packageManager: PackageManagers;
	codeActionOnSave: boolean;
	autoFix: boolean;
	autoFixOnSave: boolean;
	format: boolean;
	quiet: boolean;
	options: ESLintOptions | undefined;
	run: RunValues;
	nodePath: string | undefined;
	workspaceFolder: WorkspaceFolder | undefined;
	workingDirectory: DirectoryItem | undefined;
	library: ESLintModule | undefined;
	resolvedGlobalPackageManagerPath: string | undefined;
	codeAction: CodeActionSettings;
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

interface ESLintProblem {
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutoFixEdit;
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
	fix?: boolean | {[key: string]: any};
	fixTypes?: string[];
	fix?: boolean;
}

// { meta: { docs: [Object], schema: [Array] }, create: [Function: create] }
interface RuleData {
	meta?: {
		docs?: {
			url?: string;
		};
		type?: string;
	};
}

namespace RuleData {
	export function hasMetaType(value: RuleData | undefined): value is RuleData & { meta: { type: string; }; } {
		return value !== undefined && value.meta !== undefined && value.meta.type !== undefined;
	}
}

interface CLIEngine {
	executeOnText(content: string, file?: string, warn?: boolean): ESLintReport;
	isPathIgnored(path: string): boolean;
	// This is only available from v4.15.0 forward
	getRules?(): Map<string, RuleData>;
}

namespace CLIEngine {
	export function hasRule(value: CLIEngine): value is CLIEngine & { getRules(): Map<string, RuleData> } {
		return value.getRules !== undefined;
	}
}

interface CLIEngineConstructor {
	new (options: CLIOptions): CLIEngine;
}

interface ESLintModule {
	CLIEngine: CLIEngineConstructor;
}

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;
function loadNodeModule<T>(moduleName: string): T | undefined {
	const r =  typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require;
	try {
		return r(moduleName);
	} catch (err) {
		connection.console.error(err.stack.toString());
	}
	return undefined;
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	const message = problem.message;
	const startLine = Math.max(0, problem.line - 1);
	const startChar = Math.max(0, problem.column - 1);
	const endLine = Is.nullOrUndefined(problem.endLine) ? startLine : Math.max(0, problem.endLine - 1);
	const endChar = Is.nullOrUndefined(problem.endColumn) ? startChar : Math.max(0, problem.endColumn - 1);
	return {
		message: message,
		severity: convertSeverity(problem.severity),
		source: 'eslint',
		range: {
			start: { line: startLine, character: startChar },
			end: { line: endLine, character: endChar }
		},
		code: problem.ruleId
	};
}

interface Problem {
	label: string;
	documentVersion: number;
	ruleId: string;
	line: number;
	edit?: ESLintAutoFixEdit;
}

interface FixableProblem extends Problem {
	edit: ESLintAutoFixEdit;
}

namespace Problem {
	export function isFixable(problem: Problem): problem is FixableProblem {
		return problem.edit !== undefined;
	}
}

function computeKey(diagnostic: Diagnostic): string {
	const range = diagnostic.range;
	return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
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
	edits.set(computeKey(diagnostic), { label: `Fix this ${problem.ruleId} problem`, documentVersion: document.version, ruleId: problem.ruleId, edit: problem.fix, line: problem.line });
}

function convertSeverity(severity: number): DiagnosticSeverity {
	switch (severity) {
		// Eslint 1 is warning
		case 1:
			return DiagnosticSeverity.Warning;
		case 2:
			return DiagnosticSeverity.Error;
		default:
			return DiagnosticSeverity.Error;
	}
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

function getFileSystemPath(uri: URI): string {
	const result = uri.fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		return result[0].toUpperCase() + result.substr(1);
	} else {
		return result;
	}
}


function getFilePath(documentOrUri: string | TextDocument | URI | undefined): string | undefined {
	if (!documentOrUri) {
		return undefined;
	}
	const uri = Is.string(documentOrUri)
		? URI.parse(documentOrUri)
		: documentOrUri instanceof URI
			? documentOrUri
			: URI.parse(documentOrUri.uri);
	if (uri.scheme !== 'file') {
		return undefined;
	}
	return getFileSystemPath(uri);
}

const exitCalled = new NotificationType<[number, string], void>('eslint/exitCalled');

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

const connection = createConnection();
connection.console.info(`ESLint server running in node ${process.version}`);
// Is instantiated in the initalize handle;
let documents!: TextDocuments<TextDocument>;

const _globalPaths: { [key: string]: { cache: string | undefined; get(): string | undefined; } } = {
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

const path2Library: Map<string, ESLintModule> = new Map<string, ESLintModule>();
const document2Settings: Map<string, Promise<TextDocumentSettings>> = new Map<string, Promise<TextDocumentSettings>>();

function resolveSettings(document: TextDocument): Promise<TextDocumentSettings> {
	const uri = document.uri;
	let resultPromise = document2Settings.get(uri);
	if (resultPromise) {
		return resultPromise;
	}
	resultPromise = connection.workspace.getConfiguration({ scopeUri: uri, section: '' }).then((settings: TextDocumentSettings) => {
		settings.resolvedGlobalPackageManagerPath = globalPathGet(settings.packageManager);
		const uri = URI.parse(document.uri);
		let promise: Promise<string>;
		if (uri.scheme === 'file') {
			const file = uri.fsPath;
			const directory = path.dirname(file);
			if (settings.nodePath) {
				let nodePath = settings.nodePath;
				if (!path.isAbsolute(nodePath) && settings.workspaceFolder !== undefined) {
					const uri = URI.parse(settings.workspaceFolder.uri);
					if (uri.scheme === 'file') {
						nodePath = path.join(uri.fsPath, nodePath);
					}
				}
				promise = Files.resolve('eslint', nodePath, nodePath, trace).then<string, string>(undefined, () => {
					return Files.resolve('eslint', settings.resolvedGlobalPackageManagerPath, directory, trace);
				});
			} else {
				promise = Files.resolve('eslint', settings.resolvedGlobalPackageManagerPath, directory, trace);
			}
		} else {
			promise = Files.resolve('eslint', settings.resolvedGlobalPackageManagerPath, settings.workspaceFolder ? settings.workspaceFolder.uri : undefined, trace);
		}
		return promise.then((path) => {
			let library = path2Library.get(path);
			if (library === undefined) {
				library = loadNodeModule(path);
				if (library === undefined) {
					settings.validate = false;
					connection.console.error(`Failed to load eslint library from ${path}. See output panel for more information.`);
				} else if (library.CLIEngine === undefined) {
					settings.validate = false;
					connection.console.error(`The eslint library loaded from ${path} doesn\'t export a CLIEngine. You need at least eslint@1.0.0`);
				} else {
					connection.console.info(`ESLint library loaded from: ${path}`);
					settings.library = library;
					path2Library.set(path, library);
				}
			} else {
				settings.library = library;
			}
			return settings;
		}, () => {
			settings.validate = false;
			connection.sendRequest(NoESLintLibraryRequest.type, { source: { uri: document.uri } });
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
	private requestHandlers: Map<string, {handler: RequestHandler<any, any, any>, versionProvider?: VersionProvider<any>}>;
	private notificationHandlers: Map<string, {handler: NotificationHandler<any>, versionProvider?: VersionProvider<any>}>;
	private timer: NodeJS.Immediate | undefined;

	constructor(private connection: IConnection) {
		this.queue = [];
		this.requestHandlers = new Map();
		this.notificationHandlers = new Map();
	}

	public registerRequest<P, R, E, RO>(type: RequestType<P, R, E, RO>, handler: RequestHandler<P, R, E>, versionProvider?: VersionProvider<P>): void {
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

	public registerNotification<P, RO>(type: NotificationType<P, RO>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
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

	public addNotificationMessage<P, RO>(type: NotificationType<P, RO>, params: P, version: number) {
		this.queue.push({
			method: type.method,
			params,
			documentVersion: version
		});
		this.trigger();
	}

	public onNotification<P, RO>(type: NotificationType<P, RO>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
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
				requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
				return;
			}
			const elem = this.requestHandlers.get(requestMessage.method);
			if (elem === undefined) {
				throw new Error(`No handler registered`);
			}
			if (elem.versionProvider && requestMessage.documentVersion !== undefined && requestMessage.documentVersion !== elem.versionProvider(requestMessage.params)) {
				requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
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
	export const type: NotificationType<TextDocument, void> = new NotificationType<TextDocument, void>('eslint/validate');
}

messageQueue.onNotification(ValidateNotification.type, (document) => {
	validateSingle(document, true);
}, (document): number => {
	return document.version;
});

function getFixes(textDocument: TextDocument): TextEdit[] {
	const uri = textDocument.uri;
	const edits = codeActions.get(uri);
	function createTextEdit(editInfo: FixableProblem): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}
	if (edits) {
		const fixes = new Fixes(edits);
		if (fixes.isEmpty() || textDocument.version !== fixes.getDocumentVersion()) {
			return [];
		}
		return fixes.getOverlapFree().map(createTextEdit);
	}
	return [];
}

function setupDocumentsListeners() {
	// The documents manager listen for text document create, change
	// and close on the connection
	documents.listen(connection);
	documents.onDidOpen((event) => {
		resolveSettings(event.document).then((settings) => {
			if (!settings.validate || !TextDocumentSettings.hasLibrary(settings)) {
				return;
			}
			if (settings.format) {
				const uri = URI.parse(event.document.uri);
				const isFile = uri.scheme === 'file';
				const filter: DocumentFilter = isFile
					? { scheme: uri.scheme, pattern: uri.fsPath.replace(/\\/g, '/') }
					: { scheme: uri.scheme, pattern: uri.path };

				const options: DocumentFormattingRegistrationOptions = { documentSelector: [ filter ] };
				if (!isFile) {
					formatterRegistrations.set(event.document.uri, connection.client.register(DocumentFormattingRequest.type, options));
				} else {
					const filePath = getFilePath(uri)!;
					withCLIEngine((cli) => {
						if (!cli.isPathIgnored(filePath)) {
							formatterRegistrations.set(event.document.uri, connection.client.register(DocumentFormattingRequest.type, options));
						}
					}, filePath, settings);
				}
			}
			if (settings.run === 'onSave') {
				messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
			}
		});
	});

	// A text document has changed. Validate the document according the run setting.
	documents.onDidChangeContent((event) => {
		resolveSettings(event.document).then((settings) => {
			if (!settings.validate || settings.run !== 'onType') {
				return;
			}
			messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
		});
	});

	documents.onWillSaveWaitUntil((event) => {
		if (event.reason === TextDocumentSaveReason.AfterDelay) {
			return [];
		}

		const document = event.document;
		return resolveSettings(document).then((settings) => {
			if (!settings.autoFixOnSave) {
				return [];
			}
			// If we validate on save and want to apply fixes on will save
			// we need to validate the file.
			if (settings.run === 'onSave') {
				// Do not queue this since we want to get the fixes as fast as possible.
				return validateSingle(document, false).then(() => getFixes(document));
			} else {
				return getFixes(document);
			}
		});
	});

	// A text document has been saved. Validate the document according the run setting.
	documents.onDidSave((event) => {
		resolveSettings(event.document).then((settings) => {
			if (!settings.validate || settings.run !== 'onSave') {
				return;
			}
			messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
		});
	});

	documents.onDidClose((event) => {
		resolveSettings(event.document).then((settings) => {
			const uri = event.document.uri;
			document2Settings.delete(uri);
			codeActions.delete(uri);
			const unregister = formatterRegistrations.get(event.document.uri);
			if (unregister !== undefined) {
				unregister.then(disposable => disposable.dispose());
				formatterRegistrations.delete(event.document.uri);
			}
			if (settings.validate) {
				connection.sendDiagnostics({ uri: uri, diagnostics: [] });
			}
		});
	});
}

function environmentChanged() {
	document2Settings.clear();
	for (let document of documents.all()) {
		messageQueue.addNotificationMessage(ValidateNotification.type, document, document.version);
	}
}

function trace(message: string, verbose?: string): void {
	connection.tracer.log(message, verbose);
}

connection.onInitialize((params, _cancel, progress) => {
	progress.begin('Initializing ESLint Server');
	const syncKind: TextDocumentSyncKind = (params.initializationOptions && !!params.initializationOptions.incrementalSync) ? TextDocumentSyncKind.Incremental : TextDocumentSyncKind.Full;
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
			codeActionProvider: true,
			executeCommandProvider: {
				commands: [
					CommandIds.applySingleFix,
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
	connection.client.register(DidChangeConfigurationNotification.type, undefined);
	connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined);
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
	return resolveSettings(document).then((settings) => {
		if (!settings.validate || !TextDocumentSettings.hasLibrary(settings)) {
			return;
		}
		try {
			validate(document, settings, publishDiagnostics);
			connection.sendNotification(StatusNotification.type, { state: Status.ok });
		} catch (err) {
			let status = undefined;
			for (let handler of singleErrorHandlers) {
				status = handler(err, document, settings.library);
				if (status) {
					break;
				}
			}
			status = status || Status.error;
			connection.sendNotification(StatusNotification.type, { state: status });
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

const ruleDocData: {
	handled: Set<string>;
	urls: Map<string, string>;
} = {
	handled: new Set<string>(),
	urls: new Map<string, string>()
};

interface LintResults {
	[key: string]: any;
}

/**
 * Given a parameter similar to this, we can filter by severity and/or types:
 *
 *   fix: {
 *     severity: 2,
 *     ruleId: ["foo", "bar"]
 *   }
 *
 * Note: the field names are intentionally not validated against a whitelist so
 * that should ESLint expose more fields this extension won't have to be updated.
 */
function makeFixFilter(fix: any = true) {
	if (typeof fix === `object` && fix !== null) {
		const checks = Object.keys(fix).map(field => {
			if (Array.isArray(fix[field])) {
				const accepted = new Set(fix[field]);
				return (lintResults: LintResults) => accepted.has(lintResults[field]);
			} else {
				const accepted = fix[field];
				return (lintResults: LintResults) => lintResults[field] === accepted;
			}
		});

		return (lintResults: LintResults) => {
			return checks.every(check => {
				return check(lintResults);
			});
		};
	} else {
		return () => fix;
	}
}

const validFixTypes = new Set<string>(['problem', 'suggestion', 'layout']);
function validate(document: TextDocument, settings: TextDocumentSettings & { library: ESLintModule }, publishDiagnostics: boolean = true): void {
	const newOptions: CLIOptions = Object.assign(Object.create(null), settings.options);

	const fixFilter = makeFixFilter(newOptions.fix);
	delete newOptions.fix;

	let fixTypes: Set<string> | undefined = undefined;
	if (Array.isArray(newOptions.fixTypes) && newOptions.fixTypes.length > 0) {
		fixTypes = new Set();
		for (let item of newOptions.fixTypes) {
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
	const file = getFilePath(document);
	const cwd = process.cwd();

	try {
		if (file) {
			if (settings.workingDirectory) {
				newOptions.cwd = settings.workingDirectory.directory;
				if (settings.workingDirectory.changeProcessCWD) {
					process.chdir(settings.workingDirectory.directory);
				}
			} else if (settings.workspaceFolder) {
				const workspaceFolderUri = URI.parse(settings.workspaceFolder.uri);
				if (workspaceFolderUri.scheme === 'file') {
					const fsPath = getFileSystemPath(workspaceFolderUri);
					newOptions.cwd = fsPath;
					process.chdir(fsPath);
				}
			} else if (!settings.workspaceFolder && !isUNC(file)) {
				const directory = path.dirname(file);
				if (directory) {
					if (path.isAbsolute(directory)) {
						newOptions.cwd = directory;
					}
				}
			}
		}

		const cli = new settings.library.CLIEngine(newOptions);
		// Clean previously computed code actions.
		codeActions.delete(uri);
		const report: ESLintReport = cli.executeOnText(content, file, true);
		const diagnostics: Diagnostic[] = [];
		if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
			const docReport = report.results[0];
			if (docReport.messages && Array.isArray(docReport.messages)) {
				docReport.messages.forEach((problem) => {
					if (problem) {
						const isWarning = convertSeverity(problem.severity) === DiagnosticSeverity.Warning;
						if (settings.quiet && isWarning) {
							// Filter out warnings when quiet mode is enabled
							return;
						}
						const diagnostic = makeDiagnostic(problem);
						diagnostics.push(diagnostic);
						if (!settings.autoFix || !fixFilter(problem)) {
							// We don't want to fix problems that don't pass the validation
							return;
						}
						if (fixTypes !== undefined && isFunction(cli.getRules) && problem.ruleId !== undefined && problem.fix !== undefined) {
							const rule = cli.getRules().get(problem.ruleId);
							if (RuleData.hasMetaType(rule) && fixTypes.has(rule.meta.type)) {
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

		// cache documentation urls for all rules
		if (CLIEngine.hasRule(cli) && !ruleDocData.handled.has(uri)) {
			ruleDocData.handled.add(uri);
			cli.getRules().forEach((rule, key) => {
				if (rule.meta && rule.meta.docs && Is.string(rule.meta.docs.url)) {
					ruleDocData.urls.set(key, rule.meta.docs.url);
				}
			});
		}
	} finally {
		if (cwd !== process.cwd()) {
			process.chdir(cwd);
		}
	}
}

function withCLIEngine<T>(func: (cli: CLIEngine) => T, file: string | undefined, settings: TextDocumentSettings & { library: ESLintModule }, options?: CLIOptions): T {
	const newOptions: CLIOptions = options === undefined
		? Object.assign(Object.create(null), settings.options)
		: Object.assign(Object.create(null), settings.options, options);

	const cwd = process.cwd();
	try {
		if (file) {
			if (settings.workingDirectory) {
				newOptions.cwd = settings.workingDirectory.directory;
				if (settings.workingDirectory.changeProcessCWD) {
					process.chdir(settings.workingDirectory.directory);
				}
			} else if (settings.workspaceFolder) {
				const workspaceFolderUri = URI.parse(settings.workspaceFolder.uri);
				if (workspaceFolderUri.scheme === 'file') {
					const fsPath = getFileSystemPath(workspaceFolderUri);
					newOptions.cwd = fsPath;
					process.chdir(fsPath);
				}
			} else if (!settings.workspaceFolder && !isUNC(file)) {
				const directory = path.dirname(file);
				if (directory) {
					if (path.isAbsolute(directory)) {
						newOptions.cwd = directory;
					}
				}
			}
		}
		const cli = new settings.library.CLIEngine(newOptions);
		return func(cli);
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
	connection.window.showErrorMessage(`ESLint: ${getMessage(error, document)}. Please see the 'ESLint' output channel for details.`);
	if (Is.string(error.stack)) {
		connection.console.error('ESLint stack trace:');
		connection.console.error(error.stack);
	}
	return Status.error;
}

messageQueue.registerNotification(DidChangeWatchedFilesNotification.type, (params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	ruleDocData.handled.clear();
	ruleDocData.urls.clear();
	noConfigReported.clear();
	missingModuleReported.clear();
	params.changes.forEach((change) => {
		const fsPath = getFilePath(change.uri);
		if (fsPath === undefined || fsPath.length === 0 || isUNC(fsPath)) {
			return;
		}
		const dirname = path.dirname(fsPath);
		if (dirname) {
			const library = configErrorReported.get(fsPath);
			if (library !== undefined) {
				const cli = new library.CLIEngine({});
				try {
					cli.executeOnText('', path.join(dirname, '___test___.js'));
					configErrorReported.delete(fsPath);
				} catch (error) {
				}
			}
		}
	});
	validateMany(documents.all());
});

class Fixes {
	constructor (private edits: Map<string, Problem>) {
	}

	public static overlaps(lastEdit: FixableProblem | undefined, newEdit: FixableProblem): boolean {
		return lastEdit !== undefined && lastEdit.edit.range[1] > newEdit.edit.range[0];
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
		for(let diagnostic of diagnostics) {
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
		this.edits.forEach((value) => {
			if (Problem.isFixable(value)) {
				result.push(value);
			}
		});
		return result.sort((a, b) => {
			const d = a.edit.range[0] - b.edit.range[0];
			if (d !== 0) {
				return d;
			}
			if (a.edit.range[1] === 0) {
				return -1;
			}
			if (b.edit.range[1] === 0) {
				return 1;
			}
			return a.edit.range[1] - b.edit.range[1];
		});
	}

	public getOverlapFree(): FixableProblem[] {
		const sorted = this.getAllSorted();
		if (sorted.length <= 1) {
			return sorted;
		}
		const result: FixableProblem[] = [];
		let last: FixableProblem = sorted[0];
		result.push(last);
		for (let i = 1; i < sorted.length; i++) {
			let current = sorted[i];
			if (!Fixes.overlaps(last, current)) {
				result.push(current);
				last = current;
			}
		}
		return result;
	}
}

interface RuleCodeActions {
	fixes: CodeAction[];
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
			result = { fixes: [] };
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
		for (let actions of this._actions.values()) {
			result.push(...actions.fixes);
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
		for (let actions of this._actions.values()) {
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
}

namespace CommandParams {
	export function create(textDocument: TextDocument, ruleId?: string): CommandParams {
		return { uri: textDocument.uri, version: textDocument.version, ruleId };
	}
	export function hasRuleId(value: CommandParams): value is CommandParams & { ruleId: string } {
		return value.ruleId !== undefined;
	}
}

const changes = new Changes();
messageQueue.registerRequest(CodeActionRequest.type, (params) => {
	const result: CodeActionResult = new CodeActionResult();
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (textDocument === undefined) {
		changes.clear(textDocument);
		return result.all();
	}

	const problems = codeActions.get(uri);
	if (!problems) {
		return result.all();
	}

	function createCodeAction(title: string, kind: string, commandId: string, arg: CommandParams): CodeAction {
		const command = Command.create(title, commandId, arg);
		const action = CodeAction.create(
			title,
			command,
			kind
		);
		return action;
	}

	function createTextEdit(editInfo: FixableProblem): TextEdit {
		return TextEdit.replace(Range.create(textDocument!.positionAt(editInfo.edit.range[0]), textDocument!.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}

	function createDisableLineTextEdit(editInfo: Problem, indentationText: string): TextEdit {
		return TextEdit.insert(Position.create(editInfo.line - 1, 0), `${indentationText}// eslint-disable-next-line ${editInfo.ruleId}${EOL}`);
	}

	function createDisableSameLineTextEdit(editInfo: Problem): TextEdit {
		return TextEdit.insert(Position.create(editInfo.line - 1, Number.MAX_VALUE), ` // eslint-disable-line ${editInfo.ruleId}`);
	}

	function createDisableFileTextEdit(editInfo: Problem): TextEdit {
		return TextEdit.insert(Position.create(0, 0), `/* eslint-disable ${editInfo.ruleId} */${EOL}`);
	}

	function getLastEdit(array: FixableProblem[]): FixableProblem | undefined {
		const length = array.length;
		if (length === 0) {
			return undefined;
		}
		return array[length - 1];
	}

	return resolveSettings(textDocument).then((settings) => {
		if (params.context.only !== undefined && settings.codeActionOnSave) {
			result.fixAll.push(createCodeAction(
				`Fix all ESLint auto-fixable problems`,
				params.context.only[0],
				CommandIds.applyAllFixes,
				CommandParams.create(textDocument)
			));
			return result.all();
		}


		const fixes = new Fixes(problems);
		if (fixes.isEmpty()) {
			return result.all();
		}

		let documentVersion: number = -1;
		const allFixableRuleIds: string[] = [];

		for (let editInfo of fixes.getScoped(params.context.diagnostics)) {
			documentVersion = editInfo.documentVersion;
			const ruleId = editInfo.ruleId;
			allFixableRuleIds.push(ruleId);

			if (Problem.isFixable(editInfo)) {
				const workspaceChange = new WorkspaceChange();
				workspaceChange.getTextEditChange({uri, version: documentVersion}).add(createTextEdit(editInfo));
				changes.set(`${CommandIds.applySingleFix}:${ruleId}`, workspaceChange);
				const action = createCodeAction(
					editInfo.label,
					CodeActionKind.QuickFix,
					CommandIds.applySingleFix,
					CommandParams.create(textDocument, ruleId)
				);
				action.isPreferred = true;
				result.get(ruleId).fixes.push(action);
			}

			if (settings.codeAction.disableRuleComment.enable) {
				let workspaceChange = new WorkspaceChange();
				if (settings.codeAction.disableRuleComment.location === 'sameLine') {
					workspaceChange.getTextEditChange({uri, version: documentVersion}).add(createDisableSameLineTextEdit(editInfo));
				} else {
					const lineText = textDocument.getText(Range.create(Position.create(editInfo.line - 1, 0), Position.create(editInfo.line - 1, Number.MAX_VALUE)));
					const matches = /^([ \t]*)/.exec(lineText);
					const indentationText = matches !== null && matches.length > 0 ? matches[1] : '';
					workspaceChange.getTextEditChange({uri, version: documentVersion}).add(createDisableLineTextEdit(editInfo, indentationText));
				}
				changes.set(`${CommandIds.applyDisableLine}:${ruleId}`, workspaceChange);
				result.get(ruleId).disable = createCodeAction(
					`Disable ${ruleId} for this line`,
					CodeActionKind.QuickFix,
					CommandIds.applyDisableLine,
					CommandParams.create(textDocument, ruleId)
				);

				if (result.get(ruleId).disableFile === undefined) {
					workspaceChange = new WorkspaceChange();
					workspaceChange.getTextEditChange({uri, version: documentVersion}).add(createDisableFileTextEdit(editInfo));
					changes.set(`${CommandIds.applyDisableFile}:${ruleId}`, workspaceChange);
					result.get(ruleId).disableFile = createCodeAction(
						`Disable ${ruleId} for the entire file`,
						CodeActionKind.QuickFix,
						CommandIds.applyDisableFile,
						CommandParams.create(textDocument, ruleId)
					);
				}
			}

			if (settings.codeAction.showDocumentation.enable && result.get(ruleId).showDocumentation === undefined) {
				if (ruleDocData.urls.has(ruleId)) {
					result.get(ruleId).showDocumentation = createCodeAction(
						`Show documentation for ${ruleId}`,
						CodeActionKind.QuickFix,
						CommandIds.openRuleDoc,
						CommandParams.create(textDocument, ruleId)
					);
				}
			}
		}

		if (result.length > 0) {
			const sameProblems: Map<string, FixableProblem[]> = new Map<string, FixableProblem[]>(allFixableRuleIds.map<[string, FixableProblem[]]>(s => [s, []]));

			for (let editInfo of fixes.getAllSorted()) {
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
					const sameTextChange = sameFixes.getTextEditChange({uri, version: documentVersion});
					same.map(createTextEdit).forEach(edit => sameTextChange.add(edit));
					changes.set(CommandIds.applySameFixes, sameFixes);
					result.get(ruleId).fixAll = createCodeAction(
						`Fix all ${ruleId} problems`,
						CodeActionKind.QuickFix,
						CommandIds.applySameFixes,
						CommandParams.create(textDocument)
					);
				}
			});
			result.fixAll.push(createCodeAction(
				`Fix all auto-fixable problems`,
				CodeActionKind.QuickFix,
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

function computeAllFixes(identifier: VersionedTextDocumentIdentifier): Promise<TextEdit[]> | undefined {
	const uri = identifier.uri;
	const textDocument = documents.get(uri)!;
	if (textDocument === undefined || identifier.version !== textDocument.version) {
		return undefined;
	}

	return resolveSettings(textDocument).then((settings) => {
		if (!settings.validate || !settings.format || !TextDocumentSettings.hasLibrary(settings)) {
			return [];
		}
		const filePath = getFilePath(textDocument);
		return withCLIEngine((cli) => {
			const content = textDocument.getText();
			const report = cli.executeOnText(content, filePath);
			const result: TextEdit[] = [];
			if (Array.isArray(report.results) && report.results.length === 1 && report.results[0].output !== undefined) {
				const formatted = report.results[0].output;
				const diffs = stringDiff(content, formatted, true);
				for (let diff of diffs) {
					result.push({
						range: {
							start: textDocument.positionAt(diff.originalStart),
							end: textDocument.positionAt(diff.originalStart + diff.originalLength)
						},
						newText: formatted.substr(diff.modifiedStart, diff.modifiedLength)
					});
				}
			}
			return result;
		}, filePath, settings, { fix: true });
	});
}

messageQueue.registerRequest(ExecuteCommandRequest.type, async (params) => {
	let workspaceChange: WorkspaceChange | undefined;
	const commandParams: CommandParams = params.arguments![0];
	if (params.command === CommandIds.applyAllFixes ) {
		const edits = await computeAllFixes(commandParams);
		if (edits !== undefined) {
			workspaceChange = new WorkspaceChange();
			const textChange = workspaceChange.getTextEditChange(commandParams);
			edits.forEach(edit => textChange.add(edit));
		}
	} else {
		if ([CommandIds.applySingleFix, CommandIds.applyDisableLine, CommandIds.applyDisableFile].indexOf(params.command) !== -1) {
			workspaceChange = changes.get(`${params.command}:${commandParams.ruleId}`);
		} else if (params.command === CommandIds.openRuleDoc && CommandParams.hasRuleId(commandParams)) {
			const url = ruleDocData.urls.get(commandParams.ruleId);
			if (url) {
				connection.sendRequest(OpenESLintDocRequest.type, { url });
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
	const commandParam: CommandParams = params.arguments![0];
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
	return resolveSettings(textDocument).then((settings) => {
		if (!settings.validate || !settings.format || !TextDocumentSettings.hasLibrary(settings)) {
			return [];
		}
		const filePath = getFilePath(textDocument);
		return withCLIEngine((cli) => {
			const content = textDocument.getText();
			const report = cli.executeOnText(content, filePath);
			const result: TextEdit[] = [];
			if (Array.isArray(report.results) && report.results.length === 1 && report.results[0].output !== undefined) {
				const formatted = report.results[0].output;
				const diffs = stringDiff(content, formatted, true);
				for (let diff of diffs) {
					result.push({
						range: {
							start: textDocument.positionAt(diff.originalStart),
							end: textDocument.positionAt(diff.originalStart + diff.originalLength)
						},
						newText: formatted.substr(diff.modifiedStart, diff.modifiedLength)
					});
				}
			}
			return result;
		}, filePath, settings, { fix: true });
	});
}, (params) => {
	const document = documents.get(params.textDocument.uri);
	return document !== undefined ? document.version : undefined;
});
connection.listen();
