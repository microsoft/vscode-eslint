/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { CodeActionKind } from 'vscode-languageserver/node';

export const ESLintSourceFixAll: string = `${CodeActionKind.SourceFixAll}.eslint`;

export interface CodeActionKindFilter {
	readonly kind: CodeActionKind;
	readonly quickFix: boolean;
	readonly source: boolean;
	readonly sourceFixAll: boolean;
}

export function getCodeActionKindFilter(only: CodeActionKind[] | undefined): CodeActionKindFilter {
	if (only === undefined || only.length === 0) {
		return {
			kind: CodeActionKind.QuickFix,
			quickFix: true,
			source: false,
			sourceFixAll: false
		};
	}

	const requested = new Set<CodeActionKind>(only);
	const quickFix = requested.has(CodeActionKind.QuickFix);
	return {
		kind: quickFix ? CodeActionKind.QuickFix : only[0],
		quickFix,
		source: requested.has(CodeActionKind.Source),
		sourceFixAll: requested.has(ESLintSourceFixAll) || requested.has(CodeActionKind.SourceFixAll)
	};
}
