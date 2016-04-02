/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

export interface ESLintAutofixEdit {
	range: [number, number];
	text: string;
}

export interface ESLintProblem {
	line: number;
	column: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutofixEdit;
}

export interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
	output?: string;
}

export interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}
