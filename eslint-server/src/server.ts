/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, IRequestHandler, NotificationType, INotificationHandler,
	InitializeResult, InitializeError,
	Diagnostic, Severity, Position, Files,
	TextDocuments, ITextDocument,
	ErrorMessageTracker
} from 'vscode-languageserver';

import fs = require('fs');
import path = require('path');

interface Settings {
	eslint: {
		enable: boolean;
		options: any;
	}
	[key: string]: any;
}

interface ESLintProblem {
	line: number;
	column: number;
	severity: number;
	ruleId: string;
	message: string;
}

interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
}

interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}

let settings: Settings = null;
let options: any = null;
let lib: any = null;

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	return {
		message: problem.message,
		severity: convertSeverity(problem.severity),
		start: {
			line: problem.line - 1,
			character: problem.column - 1
		}
	};
}

function convertSeverity(severity: number): number {
	switch (severity) {
		// Eslint 1 is warning
		case 1:
			return Severity.Warning;
		case 2:
			return Severity.Error;
		default:
			return Severity.Error;
	}
}

let connection: IConnection = createConnection(process.stdin, process.stdout);
connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>> => {
	let rootFolder = params.rootFolder;
	return Files.resolveModule(rootFolder, 'eslint').then((value): InitializeResult | ResponseError<InitializeError> => {
		if (!value.CLIEngine) {
			return new ResponseError(99, 'The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0', { retry: false });
		}
		lib = value;
		let result: InitializeResult = { capabilities: { }};
		return result;
	}, (error) => {
		return Promise.reject(
			new ResponseError<InitializeError>(99,
				'Failed to load eslint library. Please install eslint in your workspace folder using \'npm install eslint\' and then press Retry.',
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
	return connection.publishDiagnostics({ uri, diagnostics });
}

function validateSingle(document: ITextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function valiateMany(documents: ITextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	documents.forEach(document => {
		try {
			validate(document);
		} catch (err) {
			tracker.add(getMessage(err, document));
		}
	});
	tracker.publish(connection);
}


let documents: TextDocuments = new TextDocuments();
// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);

// A text document has changed. Validate the document.
documents.onDidContentChange((event) => {
	validate(event.document);
});

connection.onDidChangeConfiguration((params) => {
	settings = params.settings;
	if (settings.eslint) {
		options = settings.eslint.options || {};
	}
	// Settings have changed. Revalidate all documents.
	valiateMany(documents.all());
});

connection.onDidChangeFiles((params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	valiateMany(documents.all());
});

connection.listen();