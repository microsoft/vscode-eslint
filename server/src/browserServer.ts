/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection, BrowserMessageReader, BrowserMessageWriter,
	TextDocuments, Diagnostic, DiagnosticSeverity, Range,
	TextDocumentSyncKind, ProposedFeatures, type ClientCapabilities,
	DocumentDiagnosticReportKind, type FullDocumentDiagnosticReport,
	DidChangeConfigurationNotification
} from 'vscode-languageserver/browser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Linter } from 'eslint/universal';
import js = require('@eslint/js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messageReader = new BrowserMessageReader(self as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messageWriter = new BrowserMessageWriter(self as any);

const connection = createConnection(ProposedFeatures.all, messageReader, messageWriter);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let clientCapabilities: ClientCapabilities;

const linter = new Linter();

const jsLanguageIds = new Set(['javascript', 'javascriptreact']);

const defaultConfig: Linter.Config[] = [
	js.configs.recommended as Linter.Config,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
		}
	}
];

const emptyResult: FullDocumentDiagnosticReport = {
	kind: DocumentDiagnosticReportKind.Full,
	items: []
};

function toDiagnostics(messages: Linter.LintMessage[]): Diagnostic[] {
	return messages.map(msg => {
		const startLine = Math.max(0, msg.line - 1);
		const startChar = Math.max(0, msg.column - 1);
		const endLine = Math.max(0, (msg.endLine ?? msg.line) - 1);
		const endChar = Math.max(0, (msg.endColumn ?? msg.column) - 1);
		const diagnostic: Diagnostic = {
			range: Range.create(startLine, startChar, endLine, endChar),
			severity: msg.severity === 2 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
			message: msg.message,
			source: 'eslint',
		};
		if (msg.ruleId !== null) {
			diagnostic.code = msg.ruleId;
			diagnostic.codeDescription = {
				href: `https://eslint.org/docs/rules/${msg.ruleId}`
			};
		}
		return diagnostic;
	});
}

connection.onInitialize((params) => {
	clientCapabilities = params.capabilities;
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			diagnosticProvider: {
				identifier: 'eslint',
				interFileDependencies: false,
				workspaceDiagnostics: false
			}
		}
	};
});

connection.onInitialized(() => {
	if (clientCapabilities.workspace?.didChangeConfiguration?.dynamicRegistration === true) {
		void connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
});

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document === undefined || !jsLanguageIds.has(document.languageId)) {
		return emptyResult;
	}

	const code = document.getText();
	try {
		const messages = linter.verify(code, defaultConfig, params.textDocument.uri);
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: toDiagnostics(messages)
		};
	} catch {
		return emptyResult;
	}
});

documents.listen(connection);
connection.listen();
