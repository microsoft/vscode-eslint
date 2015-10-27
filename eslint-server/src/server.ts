/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {
	ResponseError, RequestType, IRequestHandler, NotificationType, INotificationHandler,
	IValidatorConnection, createValidatorConnection, SingleFileValidator, InitializeResult, InitializeError,
	IValidationRequestor, ISimpleTextDocument, Diagnostic, Severity, Position, Files,
	LanguageServerError, MessageKind
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

let connection: IValidatorConnection = createValidatorConnection(process.stdin, process.stdout);
let validator : SingleFileValidator = {
	initialize: (rootFolder: string): Thenable<InitializeResult | ResponseError<InitializeError>> => {
		return Files.resolveModule(rootFolder, 'eslint').then((value): InitializeResult | ResponseError<InitializeError> => {
			if (!value.CLIEngine) {
				return new ResponseError(99, 'The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0', { retry: false });
			}
			lib = value;
			return null;
		}, (error) => {
			return Promise.reject(
				new ResponseError<InitializeError>(99,
					'Failed to load eslint library. Please install eslint in your workspace folder using \'npm install eslint\' and then press Retry.',
					{ retry: true }));
		});
	},
	onConfigurationChange(_settings: Settings, requestor: IValidationRequestor): void {
		settings = _settings;
		if (settings.eslint) {
			options = settings.eslint.options || {};
		}
		requestor.all();
	},
	validate: (document: ISimpleTextDocument): Diagnostic[] => {
		let CLIEngine = lib.CLIEngine;
		try {
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
			return diagnostics;
		} catch (err) {
			let message:string = null;
			if (typeof err.message === 'string' || err.message instanceof String) {
				message = <string>err.message;
				message = message.replace(/\r?\n/g, ' ');
				if (/^CLI: /.test(message)) {
					message = message.substr(5);
				}
				throw new LanguageServerError(message, MessageKind.Show);
			}
			throw err;
		}
	}
};

connection.run(validator);