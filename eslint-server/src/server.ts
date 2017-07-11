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
	TextDocuments, TextDocument, TextDocumentSyncKind, TextEdit, TextDocumentIdentifier, TextDocumentSaveReason,
	Command, BulkRegistration, BulkUnregistration,
	IPCMessageReader, IPCMessageWriter, WorkspaceChange,
	TextDocumentRegistrationOptions, TextDocumentChangeRegistrationOptions,
	DidOpenTextDocumentNotification, DidChangeTextDocumentNotification, WillSaveTextDocumentWaitUntilRequest,
	DidSaveTextDocumentNotification, DidCloseTextDocumentNotification, CodeActionRequest, VersionedTextDocumentIdentifier,
	DocumentFilter, ExecuteCommandRequest, DidChangeWatchedFilesNotification, DidChangeConfigurationNotification
} from 'vscode-languageserver';

import Uri from 'vscode-uri';
import path = require('path');

namespace Is {
	const toString = Object.prototype.toString;

	export function boolean(value: any): value is boolean {
		return value === true || value === false;
	}

	export function string(value: any): value is string {
		return toString.call(value) === '[object String]';
	}
}

namespace CommandIds {
	export const applySingleFix: string = 'eslint.applySingleFix';
	export const applySameFixes: string = 'eslint.applySameFixes';
	export const applyAllFixes: string = 'eslint.applyAllFixes';
	export const applyAutoFix: string = 'eslint.applyAutoFix';
}

interface Map<V> {
	[key: string]: V;
}

interface ESLintError extends Error {
	messageTemplate?: string;
	messageData?: {
		pluginName?: string;
	}
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

class ID {
	private static base: string = `${Date.now().toString()}-`;
	private static counter: number = 0;
	public static next(): string {
		return `${ID.base}${ID.counter++}`
	}
}

type RunValues = 'onType' | 'onSave';

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

interface DirectoryItem {
	directory: string;
	changeProcessCWD?: boolean;
}

namespace DirectoryItem {
	export function is(item: any): item is DirectoryItem {
		let candidate = item as DirectoryItem;
		return candidate && Is.string(candidate.directory) && (Is.boolean(candidate.changeProcessCWD) || candidate.changeProcessCWD === void 0);
	}
}

interface Settings {
	eslint: {
		enable?: boolean;
		autoFixOnSave?: boolean;
		options?: any;
		run?: RunValues;
		validate?: (string | ValidateItem)[];
		workingDirectories?: (string | DirectoryItem)[];
	}
	[key: string]: any;
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
	cwd: string;
}

interface CLIEngine {
	executeOnText(content: string, file?:string): ESLintReport;
}

interface CLIEngineConstructor {
	new (options: CLIOptions): CLIEngine;
}


interface ESLintModule {
	CLIEngine: CLIEngineConstructor;
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	let message = (problem.ruleId != null)
		? `${problem.message} (${problem.ruleId})`
		: `${problem.message}`;
	let startLine = Math.max(0, problem.line - 1);
	let startChar = Math.max(0, problem.column - 1);
	let endLine = problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine;
	let endChar = problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar;
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

interface AutoFix {
	label: string;
	documentVersion: number;
	ruleId: string;
	edit: ESLintAutoFixEdit;
}

function computeKey(diagnostic: Diagnostic): string {
	let range = diagnostic.range;
	return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}

let codeActions: Map<Map<AutoFix>> = Object.create(null);
function recordCodeAction(document: TextDocument, diagnostic: Diagnostic, problem: ESLintProblem): void {
	if (!problem.fix || !problem.ruleId) {
		return;
	}
	let uri = document.uri;
	let edits: Map<AutoFix> = codeActions[uri];
	if (!edits) {
		edits = Object.create(null);
		codeActions[uri] = edits;
	}
	edits[computeKey(diagnostic)] = { label: `Fix this ${problem.ruleId} problem`, documentVersion: document.version, ruleId: problem.ruleId, edit: problem.fix};
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
	let start = pos;
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

function getFilePath(documentOrUri: string | TextDocument): string {
	if (!documentOrUri) {
		return undefined;
	}
	let uri = Is.string(documentOrUri) ? Uri.parse(documentOrUri) : Uri.parse(documentOrUri.uri);
	if (uri.scheme !== 'file') {
		return undefined;
	}
	return uri.fsPath;
}

const exitCalled = new NotificationType<[number, string], void>('eslint/exitCalled');

const nodeExit = process.exit;
process.exit = (code?: number) => {
	let stack = new Error('stack');
	connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
	setTimeout(() => {
		nodeExit(code);
	}, 1000);
}

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let settings: Settings = null;
let options: any = null;
let workingDirectories: DirectoryItem[];
let documents: TextDocuments = new TextDocuments();

let supportedLanguages: Map<Thenable<BulkUnregistration>> = Object.create(null);
let willSaveRegistered: boolean = false;
let supportedAutoFixLanguages: Set<string> = new Set<string>();

let globalNodePath: string = undefined;
let nodePath: string = undefined;
let workspaceRoot: string = undefined;
let workspaceFolders: string[] = undefined;

let path2Library: Map<ESLintModule> = Object.create(null);
let document2Library: Map<Thenable<ESLintModule>> = Object.create(null);

function ignoreTextDocument(document: TextDocument): boolean {
	return !supportedLanguages[document.languageId] || !document2Library[document.uri];
}

interface Request<P, R> {
	method: string;
	params: P;
	documentVersion: number | undefined;
	resolve: (value: R | Thenable<R>) => void | undefined;
	reject: (error: any) => void | undefined;
	token: CancellationToken | undefined;
}

namespace Request {
	export function is(value: any): value is Request<any, any> {
		let candidate: Request<any, any> = value;
		return candidate && !!candidate.token && !!candidate.resolve && !!candidate.reject;
	}
}

interface Notifcation<P> {
	method: string;
	params: P;
	documentVersion: number;
}

type Message<P, R> = Notifcation<P> | Request<P, R>;

interface VersionProvider<P> {
	(params: P): number;
}

namespace Thenable {
	export function is<T>(value: any): value is Thenable<T> {
		let candidate: Thenable<T> = value;
		return candidate && typeof candidate.then === 'function';
	}
}

class BufferedMessageQueue {

	private queue: Message<any, any>[];
	private requestHandlers: Map<{handler: RequestHandler<any, any, any>, versionProvider?: VersionProvider<any>}>;
	private notificationHandlers: Map<{handler: NotificationHandler<any>, versionProvider?: VersionProvider<any>}>;
	private timer: NodeJS.Timer | undefined;

	constructor(private connection: IConnection) {
		this.queue = [];
		this.requestHandlers = Object.create(null);
		this.notificationHandlers = Object.create(null);
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
		this.requestHandlers[type.method] = { handler, versionProvider };
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
		this.notificationHandlers[type.method] = { handler, versionProvider };
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
		this.notificationHandlers[type.method] = { handler, versionProvider };
	}

	private trigger(): void {
		if (this.timer || this.queue.length === 0) {
			return;
		}
		this.timer = setImmediate(() => {
			this.timer = undefined;
			this.processQueue();
		});
	}

	private processQueue(): void {
		let message = this.queue.shift();
		if (!message) {
			return;
		}
		if (Request.is(message)) {
			let requestMessage = message;
			if (requestMessage.token.isCancellationRequested) {
				requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
				return;
			}
			let elem = this.requestHandlers[requestMessage.method];
			if (elem.versionProvider && requestMessage.documentVersion !== void 0 && requestMessage.documentVersion !== elem.versionProvider(requestMessage.params)) {
				requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
				return;
			}
			let result = elem.handler(requestMessage.params, requestMessage.token);
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
			let notificationMessage = message;
			let elem = this.notificationHandlers[notificationMessage.method];
			if (elem.versionProvider && notificationMessage.documentVersion !== void 0 && notificationMessage.documentVersion !== elem.versionProvider(notificationMessage.params)) {
				return;
			}
			elem.handler(notificationMessage.params);
		}
		this.trigger();
	}
}

let messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection);

namespace ValidateNotification {
	export const type: NotificationType<TextDocument, void> = new NotificationType<TextDocument, void>('eslint/validate');
}

messageQueue.onNotification(ValidateNotification.type, (document) => {
	validateSingle(document, true);
}, (document): number => {
	return document.version
});

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
documents.onDidOpen((event) => {
	if (!supportedLanguages[event.document.languageId]) {
		return;
	}

	if (!document2Library[event.document.uri]) {
		let uri = Uri.parse(event.document.uri);
		let promise: Thenable<string>
		if (uri.scheme === 'file') {
			let file = uri.fsPath;
			let directory = path.dirname(file);
			if (nodePath) {
				 promise = Files.resolve('eslint', nodePath, nodePath, trace).then<string, string>(undefined, () => {
					 return Files.resolve('eslint', globalNodePath, directory, trace);
				 });
			} else {
				promise = Files.resolve('eslint', globalNodePath, directory, trace);
			}
		} else {
			promise = Files.resolve('eslint', globalNodePath, workspaceRoot, trace);
		}
		document2Library[event.document.uri] = promise.then((path) => {
			let library = path2Library[path];
			if (!library) {
				library = require(path);
				if (!library.CLIEngine) {
					throw new Error(`The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0`);
				}
				connection.console.info(`ESLint library loaded from: ${path}`);
				path2Library[path] = library;
			}
			return library;
		}, () => {
			connection.sendRequest(NoESLintLibraryRequest.type, { source: { uri: event.document.uri } });
			return null;
		});
	}
	if (settings.eslint.run === 'onSave') {
		messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
	}
});

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent((event) => {
	if (settings.eslint.run !== 'onType' || ignoreTextDocument(event.document)) {
		return;
	}
	messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
});

function getFixes(textDocument: TextDocument): TextEdit[] {
	let uri = textDocument.uri
	let edits = codeActions[uri];
	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}
	if (edits) {
		let fixes = new Fixes(edits);
		if (fixes.isEmpty() || textDocument.version !== fixes.getDocumentVersion()) {
			return [];
		}
		return fixes.getOverlapFree().map(createTextEdit);
	}
	return [];
}

documents.onWillSaveWaitUntil((event) => {
	if (event.reason === TextDocumentSaveReason.AfterDelay) {
		return [];
	}

	let document = event.document;

	// If we validate on save and want to apply fixes on will save
	// we need to validate the file.
	if (settings.eslint.run === 'onSave') {
		// Do not queue this since we want to get the fixes as fast as possible.
		return validateSingle(document, false).then(() => getFixes(document));
	} else {
		return getFixes(document);
	}
});

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave((event) => {
	// We even validate onSave if we have validated on will save to compute fixes since the
	// fixes will change the content of the document.
	if (settings.eslint.run !== 'onSave' || ignoreTextDocument(event.document)) {
		return;
	}
	messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
});

documents.onDidClose((event) => {
	if (ignoreTextDocument(event.document)) {
		return;
	}
	delete document2Library[event.document.uri];
	delete codeActions[event.document.uri];
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

function trace(message: string, verbose?: string): void {
	connection.tracer.log(message, verbose);
}

connection.onInitialize((params) => {
	let initOptions: {
		legacyModuleResolve: boolean;
		nodePath: string;
		workspaceFolders: string[]
	} = params.initializationOptions;
	workspaceRoot = params.rootPath;
	nodePath = initOptions.nodePath;
	workspaceFolders = initOptions.workspaceFolders;
	globalNodePath = Files.resolveGlobalNodePath();
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.None,
			executeCommandProvider: {
				commands: [CommandIds.applySingleFix, CommandIds.applySameFixes, CommandIds.applyAllFixes, CommandIds.applyAutoFix]
			}
		}
	};
});


messageQueue.registerNotification(DidChangeConfigurationNotification.type, (params) => {
	settings = params.settings || {};
	settings.eslint = settings.eslint || {};
	options = settings.eslint.options || {};
	if (Array.isArray(settings.eslint.workingDirectories)) {
		workingDirectories = [];
		for (let workspaceFolder of workspaceFolders) {
			workingDirectories.push({
				directory: Uri.parse(workspaceFolder).fsPath,
				changeProcessCWD: true
			});
		}
		for (let entry of settings.eslint.workingDirectories) {
			let directory: string;
			let changeProcessCWD = false;
			if  (Is.string(entry)) {
				directory = entry;
			} else if (DirectoryItem.is(entry)) {
				directory = entry.directory;
				changeProcessCWD = !!entry.changeProcessCWD;
			}
			if (directory) {
				let item: DirectoryItem;
				if (path.isAbsolute(directory)) {
					item = { directory };
				} else if (workspaceRoot && directory) {
					item = { directory: path.join(workspaceRoot, directory) };
				} else {
					item = { directory: path.join(process.cwd(), directory) };
				}
				item.changeProcessCWD = changeProcessCWD;
				workingDirectories.push(item);
			}
		}
		if (workingDirectories.length === 0) {
			workingDirectories = undefined;
		} else {
			workingDirectories = workingDirectories.sort((a, b) => b.directory.length - a.directory.length);
		}
	}

	let toValidate: string[] = [];
	let toSupportAutoFix = new Set<string>();
	if (settings.eslint.validate) {
		for (const item of settings.eslint.validate) {
			if (Is.string(item)) {
				toValidate.push(item);
				if (item === 'javascript' || item === 'javascriptreact') {
					toSupportAutoFix.add(item);
				}
			} else if (ValidateItem.is(item)) {
				toValidate.push(item.language);
				if (item.autoFix) {
					toSupportAutoFix.add(item.language);
				}
			}
		}
	}

	function createDocumentSelector(language: string): DocumentFilter[] {
		return [
			{
				scheme: 'file',
				language: language
			},
			{
				scheme: 'untitled',
				language: language
			}
		];
	}

	if (settings.eslint.autoFixOnSave && !willSaveRegistered) {
		Object.keys(supportedLanguages).forEach(languageId => {
			if (!toSupportAutoFix.has(languageId)) {
				return;
			}
			let resolve = supportedLanguages[languageId];
			let documentSelector = createDocumentSelector(languageId);
			resolve.then(unregistration => {
				let documentOptions: TextDocumentRegistrationOptions = { documentSelector: documentSelector };
				connection.client.register(unregistration, WillSaveTextDocumentWaitUntilRequest.type, documentOptions);
			});
		});
		willSaveRegistered = true;
	} else if (!settings.eslint.autoFixOnSave && willSaveRegistered) {
		Object.keys(supportedLanguages).forEach(languageId => {
			if (!supportedAutoFixLanguages.has(languageId)) {
				return;
			}
			let resolve = supportedLanguages[languageId];
			resolve.then(unregistration => {
				unregistration.disposeSingle(WillSaveTextDocumentWaitUntilRequest.type.method);
			});
		});
		willSaveRegistered = false;
	}
	let toRemove: Map<boolean> = Object.create(null);
	let toAdd: Map<boolean> = Object.create(null);
	Object.keys(supportedLanguages).forEach(key => toRemove[key] = true);

	let toRemoveAutoFix: Map<boolean> = Object.create(null);
	let toAddAutoFix: Map<boolean> = Object.create(null);

	toValidate.forEach(languageId => {
		if (toRemove[languageId]) {
			// The language is past and future
			delete toRemove[languageId];
			// Check if the autoFix has changed.
			if (supportedAutoFixLanguages.has(languageId) && !toSupportAutoFix.has(languageId)) {
				toRemoveAutoFix[languageId] = true;
			} else if (!supportedAutoFixLanguages.has(languageId) && toSupportAutoFix.has(languageId)) {
				toAddAutoFix[languageId] = true;
			}
		} else {
			toAdd[languageId] = true;
		}
	});
	supportedAutoFixLanguages = toSupportAutoFix;

	let removeDone: Thenable<void>[] = [];
	let removedDocuments: Map<boolean> = Object.create(null);
	// Remove old language
	Object.keys(toRemove).forEach(languageId => {
		let resolve = supportedLanguages[languageId];
		delete supportedLanguages[languageId];
		removeDone.push(resolve.then((disposable) => {
			documents.all().forEach((textDocument) => {
				if (languageId === textDocument.languageId) {
					// When we receive the close event we already ignore the document
					// since it is not in the list of supported languages. So do the
					// cleanup here.
					delete document2Library[textDocument.uri];
					removedDocuments[textDocument.uri] = true;
					connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
				}
			});
			disposable.dispose();
		}));
	});

	// Add new languages
	Object.keys(toAdd).forEach(languageId => {
		let registration = BulkRegistration.create();
		let documentSelector = createDocumentSelector(languageId);
		let documentOptions: TextDocumentRegistrationOptions = { documentSelector: documentSelector };
		registration.add(DidOpenTextDocumentNotification.type, documentOptions);
		let didChangeOptions: TextDocumentChangeRegistrationOptions = { documentSelector: documentSelector, syncKind: TextDocumentSyncKind.Full };
		registration.add(DidChangeTextDocumentNotification.type, didChangeOptions);
		if (settings.eslint.autoFixOnSave && supportedAutoFixLanguages.has(languageId)) {
			registration.add(WillSaveTextDocumentWaitUntilRequest.type, documentOptions);
		}
		registration.add(DidSaveTextDocumentNotification.type, documentOptions);
		registration.add(DidCloseTextDocumentNotification.type, documentOptions);
		if (supportedAutoFixLanguages.has(languageId)) {
			registration.add(CodeActionRequest.type, documentOptions);
		}
		supportedLanguages[languageId] = connection.client.register(registration);
	});

	// Handle change autofix for stable langauges
	Object.keys(toRemoveAutoFix).forEach(languageId => {
		let resolve = supportedLanguages[languageId];
		resolve.then(unregistration => {
			unregistration.disposeSingle(CodeActionRequest.type.method);
			if (willSaveRegistered) {
				unregistration.disposeSingle(WillSaveTextDocumentWaitUntilRequest.type.method);
			}
		})
	});
	Object.keys(toAddAutoFix).forEach(languageId => {
		let resolve = supportedLanguages[languageId];
		let documentSelector = createDocumentSelector(languageId);
		resolve.then(unregistration => {
			let documentOptions: TextDocumentRegistrationOptions = { documentSelector: documentSelector };
			connection.client.register(unregistration, CodeActionRequest.type, documentOptions);
			if (willSaveRegistered) {
				connection.client.register(unregistration, WillSaveTextDocumentWaitUntilRequest.type, documentOptions);
			}
		})
	});

	Promise.all(removeDone).then(() => {
		// Settings have changed. Revalidate all documents.
		validateMany(documents.all().filter((document) => !removedDocuments[document.uri]));
	}, (_error) => {
		// Revalidation failed.
	});
});

const singleErrorHandlers: ((error: any, document: TextDocument, library: ESLintModule) => Status)[] = [
	tryHandleNoConfig,
	tryHandleConfigError,
	tryHandleMissingModule,
	showErrorMessage
];

function validateSingle(document: TextDocument, publishDiagnostics: boolean = true): Thenable<void> {
	// We validate document in a queue but open / close documents directly. So we need to deal with the
	// fact that a document might be gone from the server.
	if (!documents.get(document.uri) || !document2Library[document.uri]) {
		return Promise.resolve(undefined);
	}
	return document2Library[document.uri].then((library) => {
		if (!library) {
			return;
		}
		try {
			validate(document, library, publishDiagnostics);
			connection.sendNotification(StatusNotification.type, { state: Status.ok });
		} catch (err) {
			let status = undefined;
			for (let handler of singleErrorHandlers) {
				status = handler(err, document, library);
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
	let result: string = null;
	if (typeof err.message === 'string' || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, ' ');
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating document: ${document.uri}`;
	}
	return result;
}

function validate(document: TextDocument, library: ESLintModule, publishDiagnostics: boolean = true): void {
	let newOptions: CLIOptions = Object.assign(Object.create(null), options);
	let content = document.getText();
	let uri = document.uri;
	let file = getFilePath(document);
	let cwd = process.cwd();
	try {
		if (file) {
			if (workingDirectories) {
				for (let item of workingDirectories) {
					if (file.startsWith(item.directory)) {
						newOptions.cwd = item.directory;
						if (item.changeProcessCWD) {
							process.chdir(item.directory);
						}
						break;
					}
				}
			} else if (!workspaceRoot && !isUNC(file)) {
				let directory = path.dirname(file);
				if (directory) {
					if (path.isAbsolute(directory)) {
						newOptions.cwd = directory;
					}
				}
			}
		}

		let cli = new library.CLIEngine(newOptions);
		// Clean previously computed code actions.
		delete codeActions[uri];
		let report: ESLintReport = cli.executeOnText(content, file);
		let diagnostics: Diagnostic[] = [];
		if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
			let docReport = report.results[0];
			if (docReport.messages && Array.isArray(docReport.messages)) {
				docReport.messages.forEach((problem) => {
					if (problem) {
						let diagnostic = makeDiagnostic(problem);
						diagnostics.push(diagnostic);
						if (supportedAutoFixLanguages.has(document.languageId)) {
							recordCodeAction(document, diagnostic, problem);
						}
					}
				});
			}
		}
		if (publishDiagnostics) {
			connection.sendDiagnostics({ uri, diagnostics });
		}
	} finally {
		if (cwd !== process.cwd()) {
			process.chdir(cwd);
		}
	}
}

let noConfigReported: Map<ESLintModule> = Object.create(null);

function isNoConfigFoundError(error: any): boolean {
	let candidate = error as ESLintError;
	return candidate.messageTemplate === 'no-config-found' || candidate.message === 'No ESLint configuration found.';
}

function tryHandleNoConfig(error: any, document: TextDocument, library: ESLintModule): Status {
	if (!isNoConfigFoundError(error)) {
		return undefined;
	}
	if (!noConfigReported[document.uri]) {
		connection.sendRequest(
			NoConfigRequest.type,
			{
				message: getMessage(error, document),
				document: {
					uri: document.uri
				}
			})
		.then(undefined, () => { });
		noConfigReported[document.uri] = library;
	}
	return Status.warn;
}

let configErrorReported: Map<ESLintModule> = Object.create(null);

function tryHandleConfigError(error: any, document: TextDocument, library: ESLintModule): Status {
	if (!error.message) {
		return undefined;
	}

	function handleFileName(filename: string): Status {
		if (!configErrorReported[filename]) {
			connection.console.error(getMessage(error, document));
			if (!documents.get(Uri.file(filename).toString())) {
				connection.window.showInformationMessage(getMessage(error, document));
			}
			configErrorReported[filename] = library;
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

let missingModuleReported: Map<ESLintModule> = Object.create(null);

function tryHandleMissingModule(error: any, document: TextDocument, library: ESLintModule): Status {
	if (!error.message) {
		return undefined;
	}

	function handleMissingModule(plugin: string, module: string, error: ESLintError): Status {
		if (!missingModuleReported[plugin]) {
			let fsPath = getFilePath(document);
			missingModuleReported[plugin] = library;
			if (error.messageTemplate === 'plugin-missing') {
				connection.console.error([
					'',
					`${error.message.toString()}`,
					`Happend while validating ${fsPath ? fsPath : document.uri}`,
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
					`Happend while validating ${fsPath ? fsPath : document.uri}`
				].join('\n'));
			}
		}
		return Status.warn;
	}

	let matches = /Failed to load plugin (.*): Cannot find module (.*)/.exec(error.message);
	if (matches && matches.length === 3) {
		return handleMissingModule(matches[1], matches[2], error);
	}

	return undefined;
}

function showErrorMessage(error: any, document: TextDocument): Status {
	connection.window.showErrorMessage(getMessage(error, document));
	return Status.error;
}

messageQueue.registerNotification(DidChangeWatchedFilesNotification.type, (params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	noConfigReported = Object.create(null);
	missingModuleReported = Object.create(null);
	params.changes.forEach((change) => {
		let fsPath = getFilePath(change.uri);
		if (!fsPath || isUNC(fsPath)) {
			return;
		}
		let dirname = path.dirname(fsPath);
		if (dirname) {
			let library = configErrorReported[fsPath];
			if (library) {
				let cli = new library.CLIEngine(options);
				try {
					cli.executeOnText("", path.join(dirname, "___test___.js"));
					delete configErrorReported[fsPath];
				} catch (error) {
				}
			}
		}
	});
	validateMany(documents.all());
});

class Fixes {
	private keys: string[];

	constructor (private edits: Map<AutoFix>) {
		this.keys = Object.keys(edits);
	}

	public static overlaps(lastEdit: AutoFix, newEdit: AutoFix): boolean {
		return !!lastEdit && lastEdit.edit.range[1] > newEdit.edit.range[0];
	}

	public isEmpty(): boolean {
		return this.keys.length === 0;
	}

	public getDocumentVersion(): number {
		return this.edits[this.keys[0]].documentVersion;
	}

	public getScoped(diagnostics: Diagnostic[]): AutoFix[] {
		let result: AutoFix[] = [];
		for(let diagnostic of diagnostics) {
			let key = computeKey(diagnostic);
			let editInfo = this.edits[key];
			if (editInfo) {
				result.push(editInfo);
			}
		}
		return result;
	}

	public getAllSorted(): AutoFix[] {
		let result = this.keys.map(key => this.edits[key]);
		return result.sort((a, b) => {
			let d = a.edit.range[0] - b.edit.range[0];
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

	public getOverlapFree(): AutoFix[] {
		let sorted = this.getAllSorted();
		if (sorted.length <= 1) {
			return sorted;
		}
		let result: AutoFix[] = [];
		let last: AutoFix = sorted[0];
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

let commands: Map<WorkspaceChange> = Object.create(null);
messageQueue.registerRequest(CodeActionRequest.type, (params) => {
	commands = Object.create(null);
	let result: Command[] = [];
	let uri = params.textDocument.uri;
	let edits = codeActions[uri];
	if (!edits) {
		return result;
	}

	let fixes = new Fixes(edits);
	if (fixes.isEmpty()) {
		return result;
	}

	let textDocument = documents.get(uri);
	let documentVersion: number = -1;
	let ruleId: string;

	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}

	function getLastEdit(array: AutoFix[]): AutoFix {
		let length = array.length;
		if (length === 0) {
			return undefined;
		}
		return array[length - 1];
	}

	for (let editInfo of fixes.getScoped(params.context.diagnostics)) {
		documentVersion = editInfo.documentVersion;
		ruleId = editInfo.ruleId;
		let workspaceChange = new WorkspaceChange();
		workspaceChange.getTextEditChange({uri, version: documentVersion}).add(createTextEdit(editInfo));
		commands[CommandIds.applySingleFix] = workspaceChange;
		result.push(Command.create(editInfo.label, CommandIds.applySingleFix));
	};

	if (result.length > 0) {
		let same: AutoFix[] = [];
		let all: AutoFix[] = [];


		for (let editInfo of fixes.getAllSorted()) {
			if (documentVersion === -1) {
				documentVersion = editInfo.documentVersion;
			}
			if (editInfo.ruleId === ruleId && !Fixes.overlaps(getLastEdit(same), editInfo)) {
				same.push(editInfo);
			}
			if (!Fixes.overlaps(getLastEdit(all), editInfo)) {
				all.push(editInfo);
			}
		}
		if (same.length > 1) {
			let sameFixes: WorkspaceChange = new WorkspaceChange();
			let sameTextChange = sameFixes.getTextEditChange({uri, version: documentVersion});
			same.map(createTextEdit).forEach(edit => sameTextChange.add(edit));
			commands[CommandIds.applySameFixes] = sameFixes;
			result.push(Command.create(`Fix all ${ruleId} problems`, CommandIds.applySameFixes));
		}
		if (all.length > 1) {
			let allFixes: WorkspaceChange = new WorkspaceChange();
			let allTextChange = allFixes.getTextEditChange({uri, version: documentVersion});
			all.map(createTextEdit).forEach(edit => allTextChange.add(edit));
			commands[CommandIds.applyAllFixes] = allFixes;
			result.push(Command.create(`Fix all auto-fixable problems`, CommandIds.applyAllFixes));
		}
	}
	return result;
}, (params): number => {
	let document = documents.get(params.textDocument.uri);
	return document ? document.version : undefined;
});

function computeAllFixes(identifier: VersionedTextDocumentIdentifier): TextEdit[] {
	let uri = identifier.uri;
	let textDocument = documents.get(uri);
	if (!textDocument || identifier.version !== textDocument.version) {
		return undefined;
	}
	let edits = codeActions[uri];
	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}

	if (edits) {
		let fixes = new Fixes(edits);
		if (!fixes.isEmpty()) {
			return fixes.getOverlapFree().map(createTextEdit);
		}
	}
	return undefined;
};

messageQueue.registerRequest(ExecuteCommandRequest.type, (params) => {
	let workspaceChange: WorkspaceChange;
	if (params.command === CommandIds.applyAutoFix) {
		let identifier: VersionedTextDocumentIdentifier = params.arguments[0];
		let edits = computeAllFixes(identifier);
		if (edits) {
			workspaceChange = new WorkspaceChange();
			let textChange = workspaceChange.getTextEditChange(identifier);
			edits.forEach(edit => textChange.add(edit));
		}
	} else {
		workspaceChange = commands[params.command];
	}

	if (!workspaceChange) {
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
}, (params): number => {
	if (params.command === CommandIds.applyAutoFix) {
		let identifier: VersionedTextDocumentIdentifier = params.arguments[0];
		return identifier.version;
	} else {
		return undefined;
	}
});
connection.listen();