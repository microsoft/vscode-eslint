/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {Uri} from 'vscode';
import {RequestType} from 'vscode-languageclient';

/**
 * The autofix method is sent from the client to the server.
 */
export namespace ESLintAutofixRequest {
	export const type: RequestType<ESLintAutofixParams, ESLintAutofixResult, void> = {
		get method() { return 'eslint/executeAutofix'; }
	};
}

/**
 * The parameters of ESLint autofix request.
 */
export interface ESLintAutofixParams {
	/**
	 * The Uri of the target document.
	 */
	uri: string;

	/**
	 * The flag to indicate that this request target is being hidden.
	 * If this is `true`, the server would rewrite the target file directly.
	 */
	hidden: boolean;

	/**
	 * The flag to indicate this request was triggered by saved.
	 * If this is `true` and the `eslint.enableAutofixOnSave` configure is `false`, the request would be ignored.
	 */
	onSaved: boolean;
}

/**
 * The result of ESLint autofix request.
 */
export interface ESLintAutofixResult {
	/**
	 * The fixed content.
	 * This is `undefined` if no change.
	 */
	fixedContent?: string;
}
