/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

// This should either come from LSP or VS Code. That we repeat this is bogus.

type LanguageConfig = {
	ext: string;
	lineComment?: string;
	blockComment: [string, string];
};

const languageId2Config: Map<string, LanguageConfig> = new Map([
	['javascript', { ext: 'js', lineComment: '//', blockComment: ['/*', '*/'] }],
	['javascriptreact', { ext: 'jsx', lineComment: '//', blockComment: ['/*', '*/'] }],
	['typescript', { ext: 'ts', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['typescriptreact', { ext: 'tsx', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['html', { ext: 'html', lineComment: '//', blockComment: ['<!--', '-->'] }],
	['vue', { ext: 'vue', lineComment: '//', blockComment: ['<!--', '-->'] }],
	['markdown', { ext: 'md', blockComment: ['<!--', '-->'] }],
	['coffeescript', { ext: 'coffee', lineComment: '#', blockComment: ['###', '###'] }],
	['yaml', { ext: 'yaml', lineComment: '#', blockComment: ['#', ''] }],
	['graphql', { ext: 'graphql', lineComment: '#', blockComment: ['#', ''] }]
]);

namespace LanguageDefaults {
	export function getLineComment(languageId: string): string | undefined {
		const config = languageId2Config.get(languageId);
		return config !== undefined ? config.lineComment : '//';
	}

	export function getBlockComment(languageId: string): [string, string] {
		return languageId2Config.get(languageId)?.blockComment ?? ['/*', '*/'];
	}

	export function getExtension(languageId: string): string | undefined {
		return languageId2Config.get(languageId)?.ext;
	}
}

export default LanguageDefaults;