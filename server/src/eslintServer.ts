/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import { EOL } from 'os';

import {
	createConnection, Diagnostic, Range, TextDocuments, TextDocumentSyncKind, TextEdit, Command, WorkspaceChange, VersionedTextDocumentIdentifier,
	DidChangeConfigurationNotification,  CodeAction, CodeActionKind, Position, TextDocumentEdit, Message as LMessage, ResponseMessage as LResponseMessage,
	uinteger, ServerCapabilities, NotebookDocuments, ProposedFeatures, ClientCapabilities, type FullDocumentDiagnosticReport, DocumentDiagnosticReportKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import {
	ExitCalled, OpenESLintDocRequest, Status, StatusNotification
} from './shared/customMessages';

import { Validate, CodeActionsOnSaveMode } from './shared/settings';

import {
	CodeActions, ESLint, ESLintClassOptions, FixableProblem, Fixes, Problem, RuleMetaData, RuleSeverities,
	SaveRuleConfigs, SuggestionsProblem, TextDocumentSettings,
} from './eslint';

import { getFileSystemPath, getUri, isUNC } from './paths';
import { stringDiff } from './diff';
import LanguageDefaults from './languageDefaults';

// The connection to use. Code action requests get removed from the queue if
// canceled.
const connection: ProposedFeatures.Connection = createConnection(ProposedFeatures.all, {
	connectionStrategy: {
		cancelUndispatched: (message: LMessage) => {
		// Code actions can safely be cancel on request.
			if (LMessage.isRequest(message) && message.method === 'textDocument/codeAction') {
				const response: LResponseMessage = {
					jsonrpc: message.jsonrpc,
					id: message.id,
					result: null
				};
				return response;
			}
			return undefined;
		}
	},
	maxParallelism: 1
});

// Set when handling the initialize request.
let clientCapabilities: ClientCapabilities;

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
// The notebooks manager is using the normal document manager for the cell documents.
// So all validating will work out of the box since normal document events will fire.
const notebooks = new NotebookDocuments(documents);

// This makes loading work in a plain NodeJS and a WebPacked environment
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

// Some plugins call exit which will terminate the server.
// To not loose the information we sent such a behavior
// to the client.
const nodeExit = process.exit;
process.exit = ((code?: number): void => {
	const stack = new Error('stack');
	void connection.sendNotification(ExitCalled.type, [code ? code : 0, stack.stack]);
	setTimeout(() => {
		nodeExit(code);
	}, 1000);
}) as any;

// Handling of uncaught exceptions hitting the event loop.
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

/**
 * Infers a file path for a given URI / TextDocument. If the document is a notebook
 * cell document it uses the file path from the notebook with a corresponding
 * extension (e.g. TypeScript -> ts)
 */
function inferFilePath(documentOrUri: string | TextDocument | URI | undefined): string | undefined {
	if (!documentOrUri) {
		return undefined;
	}
	const uri = getUri(documentOrUri);
	if (uri.scheme === 'file') {
		return getFileSystemPath(uri);
	}

	const notebookDocument = notebooks.findNotebookDocumentForCell(uri.toString());
	if (notebookDocument !== undefined ) {
		const notebookUri = URI.parse(notebookDocument.uri);
		if (notebookUri.scheme === 'file') {
			const filePath = getFileSystemPath(uri);
			if (filePath !== undefined) {
				const textDocument = documents.get(uri.toString());
				if (textDocument !== undefined) {
					const extension = LanguageDefaults.getExtension(textDocument.languageId);
					if (extension !== undefined) {
						const extname = path.extname(filePath);
						if (extname.length === 0 && filePath[0] === '.') {
							return `${filePath}.${extension}`;
						} else if (extname.length > 0 && extname !== extension) {
							return `${filePath.substring(0, filePath.length - extname.length)}.${extension}`;
						}
					}
				}
			}
		}
	}
	return undefined;
}

ESLint.initialize(connection, documents, inferFilePath, loadNodeModule);
SaveRuleConfigs.inferFilePath = inferFilePath;

documents.onDidClose(async (event) => {
	const document = event.document;
	const uri = document.uri;
	ESLint.removeSettings(uri);
	SaveRuleConfigs.remove(uri);
	CodeActions.remove(uri);
	ESLint.unregisterAsFormatter(document);
});

function environmentChanged() {
	ESLint.clearSettings();
	RuleSeverities.clear();
	SaveRuleConfigs.clear();
	ESLint.clearFormatters();
	connection.languages.diagnostics.refresh().catch(() => {
		connection.console.error('Failed to refresh diagnostics');
	});
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

connection.onInitialize((params, _cancel, progress) => {
	progress.begin('Initializing ESLint Server');
	const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Incremental;
	clientCapabilities = params.capabilities;
	progress.done();
	const capabilities: ServerCapabilities = {
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
		},
		diagnosticProvider: {
			identifier: 'eslint',
			interFileDependencies: false,
			workspaceDiagnostics: false
		}
	};

	if (clientCapabilities.textDocument?.codeAction?.codeActionLiteralSupport?.codeActionKind.valueSet !== undefined) {
		capabilities.codeActionProvider = {
			codeActionKinds: [CodeActionKind.QuickFix, `${CodeActionKind.SourceFixAll}.eslint`]
		};
	}

	return { capabilities };
});

connection.onInitialized(() => {
	if (clientCapabilities.workspace?.didChangeConfiguration?.dynamicRegistration === true) {
		connection.onDidChangeConfiguration((_params) => {
			environmentChanged();
		});
		void connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}

	if (clientCapabilities.workspace?.workspaceFolders === true) {
		connection.workspace.onDidChangeWorkspaceFolders((_params) => {
			environmentChanged();
		});
	}
});


const emptyDiagnosticResult: FullDocumentDiagnosticReport = {
	kind: DocumentDiagnosticReportKind.Full,
	items: []
};

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document === undefined) {
		return emptyDiagnosticResult;
	}

	const settings = await ESLint.resolveSettings(document);
	if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings)) {
		return emptyDiagnosticResult;
	}
	try {
		const start = Date.now();
		const diagnostics = await ESLint.validate(document, settings);
		const timeTaken = Date.now() - start;
		void connection.sendNotification(StatusNotification.type, { uri: document.uri, state: Status.ok, validationTime: timeTaken });
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: diagnostics
		};
	} catch (err) {
		// if an exception has occurred while validating clear all errors to ensure
		// we are not showing any stale once
		if (!settings.silent) {
			let status: Status | undefined = undefined;
			for (const handler of ESLint.ErrorHandlers.single) {
				status = handler(err, document, settings.library, settings);
				if (status) {
					break;
				}
			}
			status = status || Status.error;
			void connection.sendNotification(StatusNotification.type, { uri: document.uri, state: status });
		} else {
			connection.console.info(ESLint.ErrorHandlers.getMessage(err, document));
			void connection.sendNotification(StatusNotification.type, { uri: document.uri, state: Status.ok });
		}
		return emptyDiagnosticResult;
	}
});

connection.onDidChangeWatchedFiles(async (params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	RuleMetaData.clear();
	ESLint.ErrorHandlers.clearNoConfigReported();
	ESLint.ErrorHandlers.clearMissingModuleReported();
	ESLint.clearSettings(); // config files can change plugins and parser.
	RuleSeverities.clear();
	SaveRuleConfigs.clear();

	await Promise.all(params.changes.map(async (change) => {
		const fsPath = inferFilePath(change.uri);
		if (fsPath === undefined || fsPath.length === 0 || isUNC(fsPath)) {
			return;
		}
		const dirname = path.dirname(fsPath);
		if (dirname) {
			const data = ESLint.ErrorHandlers.getConfigErrorReported(fsPath);
			if (data !== undefined) {
				const eslintClass = await ESLint.newClass(data.library, {}, data.settings);
				try {
					await eslintClass.lintText('', { filePath: path.join(dirname, '___test___.js') });
					ESLint.ErrorHandlers.removeConfigErrorReported(fsPath);
				} catch (error) {
				}
			}
		}
	}));
	connection.languages.diagnostics.refresh().catch(() => {
		connection.console.error('Failed to refresh diagnostics');
	});
});

type RuleCodeActions = {
	fixes: CodeAction[];
	suggestions: CodeAction[];
	disable?: CodeAction;
	fixAll?: CodeAction;
	disableFile?: CodeAction;
	showDocumentation?: CodeAction;
};

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

connection.onCodeAction(async (params) => {
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

	function getDisableRuleEditInsertionIndex(line: string, commentTags: string | [string, string]): number {
		let charIndex = line.indexOf('--');

		if (charIndex < 0) {
			if (typeof commentTags === 'string') {
				return line.length;
			} else { // commentTags is an array containing the block comment closing and opening tags
				charIndex = line.indexOf(commentTags[1]);
				while (charIndex > 0 && line[charIndex - 1] === ' ') {
					charIndex--;
				}
			}
		} else {
			while (charIndex > 1 && line[charIndex - 1] === ' ') {
				charIndex--;
			}
		}

		return charIndex;
	}

	/**
	 * Prefix characters with special meaning in comment markers with a backslash
	 * See also: https://github.com/microsoft/vscode-eslint/issues/1610
	 */
	function escapeStringRegexp(value: string) {
		return value.replace(/[|{}\\()[\]^$+*?.]/g, '\\$&');
	}

	function createDisableLineTextEdit(textDocument: TextDocument, editInfo: Problem, indentationText: string): TextEdit {
		const lineComment = LanguageDefaults.getLineComment(textDocument.languageId);
		const blockComment = LanguageDefaults.getBlockComment(textDocument.languageId);

		// If the concerned line is not the first line of the file
		if (editInfo.line - 1 > 0) {
			// Check previous line if there is a eslint-disable-next-line comment already present.
			const prevLine = textDocument.getText(Range.create(Position.create(editInfo.line - 2, 0), Position.create(editInfo.line - 2, uinteger.MAX_VALUE)));

			// For consistency, we ignore the settings here and use the comment style from that
			// specific line.
			const matchedLineDisable = new RegExp(`${escapeStringRegexp(lineComment)} eslint-disable-next-line`).test(prevLine);
			if (matchedLineDisable) {
				const insertionIndex = getDisableRuleEditInsertionIndex(prevLine, lineComment);
				return TextEdit.insert(Position.create(editInfo.line - 2, insertionIndex), `, ${editInfo.ruleId}`);
			}

			const matchedBlockDisable = new RegExp(`${escapeStringRegexp(blockComment[0])} eslint-disable-next-line`).test(prevLine);
			if (matchedBlockDisable) {
				const insertionIndex = getDisableRuleEditInsertionIndex(prevLine, blockComment);
				return TextEdit.insert(Position.create(editInfo.line - 2, insertionIndex), `, ${editInfo.ruleId}`);
			}
		}

		// We're creating a new disabling comment. Use the comment style given in settings.
		const commentStyle = settings.codeAction.disableRuleComment.commentStyle;
		let disableRuleContent: string;
		if (commentStyle === 'block') {
			disableRuleContent = `${indentationText}${blockComment[0]} eslint-disable-next-line ${editInfo.ruleId} ${blockComment[1]}${EOL}`;
		} else { // commentStyle === 'line'
			disableRuleContent = `${indentationText}${lineComment} eslint-disable-next-line ${editInfo.ruleId}${EOL}`;
		}

		return TextEdit.insert(Position.create(editInfo.line - 1, 0), disableRuleContent);
	}

	function createDisableSameLineTextEdit(textDocument: TextDocument, editInfo: Problem): TextEdit {
		const lineComment = LanguageDefaults.getLineComment(textDocument.languageId);
		const blockComment = LanguageDefaults.getBlockComment(textDocument.languageId);
		const currentLine = textDocument.getText(Range.create(Position.create(editInfo.line - 1, 0), Position.create(editInfo.line - 1, uinteger.MAX_VALUE)));
		let disableRuleContent: string;
		let insertionIndex: number;

		// Check if there's already a disabling comment. If so, we ignore the settings here
		// and use the comment style from that specific line.
		const matchedLineDisable = new RegExp(`${lineComment} eslint-disable-line`).test(currentLine);
		const matchedBlockDisable = new RegExp(`${blockComment[0]} eslint-disable-line`).test(currentLine);
		if (matchedLineDisable) {
			disableRuleContent = `, ${editInfo.ruleId}`;
			insertionIndex = getDisableRuleEditInsertionIndex(currentLine, lineComment);
		} else if (matchedBlockDisable) {
			disableRuleContent = `, ${editInfo.ruleId}`;
			insertionIndex = getDisableRuleEditInsertionIndex(currentLine, blockComment);
		} else {
			// We're creating a new disabling comment.
			const commentStyle = settings.codeAction.disableRuleComment.commentStyle;
			disableRuleContent = commentStyle === 'line' ? ` ${lineComment} eslint-disable-line ${editInfo.ruleId}` : ` ${blockComment[0]} eslint-disable-line ${editInfo.ruleId} ${blockComment[1]}`;
			insertionIndex = uinteger.MAX_VALUE;
		}

		return TextEdit.insert(Position.create(editInfo.line - 1, insertionIndex), disableRuleContent);
	}

	function createDisableFileTextEdit(textDocument: TextDocument, editInfo: Problem): TextEdit {
		// If first line contains a shebang, insert on the next line instead.
		const shebang = textDocument.getText(Range.create(Position.create(0, 0), Position.create(0, 2)));
		const line = shebang === '#!' ? 1 : 0;
		const block = LanguageDefaults.getBlockComment(textDocument.languageId);
		return TextEdit.insert(Position.create(line, 0), `${block[0]} eslint-disable ${editInfo.ruleId} ${block[1]}${EOL}`);
	}

	function getLastEdit(array: FixableProblem[]): FixableProblem | undefined {
		const length = array.length;
		if (length === 0) {
			return undefined;
		}
		return array[length - 1];
	}

	const settings = await ESLint.resolveSettings(textDocument);

	// The file is not validated at all or we couldn't load an eslint library for it.
	if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings)) {
		return result.all();
	}

	const problems = CodeActions.get(uri);
	// We validate on type and have no problems ==> nothing to fix.
	if (problems === undefined && settings.run === 'onType') {
		return result.all();
	}

	const only: string | undefined = params.context.only !== undefined && params.context.only.length > 0 ? params.context.only[0] : undefined;
	const isSource = only === CodeActionKind.Source;
	const isSourceFixAll = (only === ESLintSourceFixAll || only === CodeActionKind.SourceFixAll);
	if (isSourceFixAll || isSource) {
		if (isSourceFixAll) {
			const textDocumentIdentifier: VersionedTextDocumentIdentifier = { uri: textDocument.uri, version: textDocument.version };
			const edits = await computeAllFixes(textDocumentIdentifier, AllFixesMode.onSave);
			if (edits !== undefined) {
				result.fixAll.push(CodeAction.create(
					`Fix all fixable ESLint issues`,
					{ documentChanges: [ TextDocumentEdit.create(textDocumentIdentifier, edits )]},
					ESLintSourceFixAll
				));
			}
		} else if (isSource) {
			result.fixAll.push(createCodeAction(
				`Fix all fixable ESLint issues`,
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

		if (settings.codeAction.disableRuleComment.enable && ruleId !== RuleMetaData.unusedDisableDirectiveId) {
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

	const settings = await ESLint.resolveSettings(textDocument);

	if (settings.validate !== Validate.on || !TextDocumentSettings.hasLibrary(settings) || (mode === AllFixesMode.format && !settings.format)) {
		return [];
	}
	const filePath = inferFilePath(textDocument);
	const problems = CodeActions.get(uri);
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
		const saveConfig = filePath !== undefined && mode === AllFixesMode.onSave ? await SaveRuleConfigs.get(uri, settings) : undefined;
		const offRules = saveConfig?.offRules;
		const overrideOptions = saveConfig?.options;
		let eslintOptions: ESLintClassOptions = { fix: true };
		if (offRules !== undefined || overrideOptions !== undefined) {
			if (overrideOptions !== undefined) {
				eslintOptions = { ...eslintOptions, ...overrideOptions };
			}
			if (offRules !== undefined && offRules.size > 0) {
				const overrideConfig = { rules: Object.create(null) };
				for (const ruleId of offRules) {
					overrideConfig.rules[ruleId] = 'off';
				}
				eslintOptions.overrideConfig = overrideConfig;
			}
		}
		return ESLint.withClass(async (eslintClass) => {
			// Don't use any precomputed fixes since neighbour fixes can produce incorrect results.
			// See https://github.com/microsoft/vscode-eslint/issues/1745
			const result: TextEdit[] = [];
			const reportResults = await eslintClass.lintText(originalContent, { filePath });
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
			}
			return result;
		}, settings, eslintOptions);
	}
}

connection.onExecuteCommand(async (params) => {
	let workspaceChange: WorkspaceChange | undefined;
	const commandParams: CommandParams = params.arguments![0] as CommandParams;
	if (params.command === CommandIds.applyAllFixes) {
		const edits = await computeAllFixes(commandParams, AllFixesMode.command);
		if (edits !== undefined && edits.length > 0) {
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
		return null;
	}
	return connection.workspace.applyEdit(workspaceChange.edit).then((response) => {
		if (!response.applied) {
			connection.console.error(`Failed to apply command: ${params.command}`);
		}
		return null;
	}, () => {
		connection.console.error(`Failed to apply command: ${params.command}`);
		return null;
	});
});

connection.onDocumentFormatting((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (textDocument === undefined) {
		return [];
	}
	return computeAllFixes({ uri: textDocument.uri, version: textDocument.version }, AllFixesMode.format);
});


documents.listen(connection);
notebooks.listen(connection);
connection.listen();
connection.console.info(`ESLint server running in node ${process.version}`);
