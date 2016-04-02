/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, IRequestHandler, NotificationType, INotificationHandler,
	InitializeResult, InitializeError,
	Diagnostic, DiagnosticSeverity, Position, Files,
	TextDocuments, ITextDocument, TextDocumentSyncKind,
	ErrorMessageTracker, IPCMessageReader, IPCMessageWriter
} from 'vscode-languageserver';
import {ESLintReport, ESLintProblem, ESLintAutofixEdit} from "./lib/eslint";
import {ESLintAutofixRequest} from "./lib/protocol";

import fs = require('fs');
import path = require('path');

interface Settings {
	eslint: {
		enable: boolean;
		enableAutofixOnSave: boolean;
		options: any;
	}
	[key: string]: any;
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	let message = (problem.ruleId != null)
		? `${problem.message} (${problem.ruleId})`
		: `${problem.message}`;
	return {
		message: message,
		severity: convertSeverity(problem.severity),
		source: 'eslint',
		range: {
			start: { line: problem.line - 1, character: problem.column - 1 },
			end: { line: problem.line - 1, character: problem.column - 1 }
		}
	};
}

function convertSeverity(severity: number): number {
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

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let lib: any = null;
let settings: Settings = null;
let options: any = null;
let documents: TextDocuments = new TextDocuments();

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
// A text document has changed. Validate the document.
documents.onDidChangeContent((event) => {
	validateSingle(event.document);
});

connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>> => {
	let rootPath = params.rootPath;
	return Files.resolveModule(rootPath, 'eslint').then((value): InitializeResult | ResponseError<InitializeError> => {
		if (!value.CLIEngine) {
			return new ResponseError(99, 'The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0', { retry: false });
		}
		lib = value;
		let result: InitializeResult = { capabilities: { textDocumentSync: documents.syncKind }};
		return result;
	}, (error) => {
		return Promise.reject(
			new ResponseError<InitializeError>(99,
				'Failed to load eslint library. Please install eslint in your workspace folder using \'npm install eslint\' or globally using \'npm install -g eslint\' and then press Retry.',
				{ retry: true }));
	});
})

function getMessage(err: any, document: ITextDocument): string {
	let result: string = null;
	if (typeof err.message === 'string' || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, ' ');
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
	}
	return result;
}

function validate(document: ITextDocument): void {
	let CLIEngine = lib.CLIEngine;
	var cli = new CLIEngine(options);
	let content = document.getText();
	let uri = document.uri;
	let report: ESLintReport = cli.executeOnText(content, Files.uriToFilePath(uri));
	let diagnostics: Diagnostic[] = [];
	if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
		let docReport = report.results[0];
		if (docReport.messages && Array.isArray(docReport.messages)) {
			docReport.messages.forEach((problem) => {
				if (problem) {
					diagnostics.push(makeDiagnostic(problem));
				}
			});
		}
	}
	// Publish the diagnostics
	return connection.sendDiagnostics({ uri, diagnostics });
}

function validateSingle(document: ITextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function validateMany(documents: ITextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	documents.forEach(document => {
		try {
			validate(document);
		} catch (err) {
			tracker.add(getMessage(err, document));
		}
	});
	tracker.sendErrors(connection);
}

connection.onDidChangeConfiguration((params) => {
	settings = params.settings;
	if (settings.eslint) {
		options = settings.eslint.options || {};
	}
	// Settings have changed. Revalidate all documents.
	validateMany(documents.all());
});

connection.onDidChangeWatchedFiles((params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	validateMany(documents.all());
});

// The handler of autofix command.
connection.onRequest(ESLintAutofixRequest.type, (params) => {
	// Checks the current configure.
	if (!settings ||
		!settings.eslint.enable ||
		(params.onSaved && !settings.eslint.enableAutofixOnSave)
	) {
		return {edits: []};
	}

	// Gets the target document.
	let document = documents.get(params.uri);
	if (document == null) {
		return {edits: []};
	}

	// Calculate autofix.
	let cli = new lib.CLIEngine(options);
	let report: ESLintReport = cli.executeOnText(
		document.getText(),
		Files.uriToFilePath(params.uri)
	);
	let edits: ESLintAutofixEdit[] = report.results[0].messages
		.filter(problem => problem.fix != null)
		.map(problem => problem.fix);

	edits.sort((a, b) => a.range[1] - b.range[0]);

	return {edits};
});

connection.listen();
