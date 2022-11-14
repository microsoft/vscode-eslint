/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

// This should either come from LSP or VS Code. That we repeat this is bogus.
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

type LanguageConfig = {
	ext: string;
	lineComment: string;
	blockComment: [string, string];
};

const languageId2Config: Map<string, LanguageConfig> = new Map([
	['javascript', { ext: 'js', lineComment: '//', blockComment: ['/*', '*/'] }],
	['javascriptreact', { ext: 'jsx', lineComment: '//', blockComment: ['/*', '*/'] }],
	['typescript', { ext: 'ts', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['typescriptreact', { ext: 'tsx', lineComment: '//', blockComment: ['/*', '*/'] } ],
	['html', { ext: 'html', lineComment: '//', blockComment: ['<!--', '-->'] }],
	['vue', { ext: 'vue', lineComment: '//', blockComment: ['<!--', '-->'] }],
	['coffeescript', { ext: 'coffee', lineComment: '#', blockComment: ['###', '###'] }],
	['yaml', { ext: 'yaml', lineComment: '#', blockComment: ['#', ''] }],
	['graphql', { ext: 'graphql', lineComment: '#', blockComment: ['#', ''] }]
]);

namespace LanguageDefaults {
	function getFileExtension(uri: string) {
		var path = URI.parse(uri).path;
		var fileName = path.substring(path.lastIndexOf('/') + 1);
		var lastIndexOfDot = fileName.lastIndexOf('.');
		return fileName.substring(lastIndexOfDot + 1);
	}

	function getLanguageConfig(document: TextDocument): LanguageConfig | undefined {
		var languageId = document.languageId;
		var conf = languageId2Config.get(languageId);
		if (conf !== undefined) {
			return conf;
		}
		if (document.uri !== undefined) {
			var extension = getFileExtension(document.uri);
			for (let [, config] of languageId2Config) {
				if (config.ext === extension) {
					return config;
				}
			}
		}
		return undefined;
	}

	export function getLineComment(document: TextDocument): string {
		return getLanguageConfig(document)?.lineComment ?? '//';
	}

	export function getBlockComment(document: TextDocument): [string, string] {
		return getLanguageConfig(document)?.blockComment ?? ['/**', '*/'];
	}

	export function getExtension(document: TextDocument): string | undefined {
		return getLanguageConfig(document)?.ext;
	}

}

export default LanguageDefaults;