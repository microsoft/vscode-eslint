/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import type { ESLintModule } from './eslint';
import type { ConfigurationSettings, DirectoryItem } from './shared/settings';

/**
 * Settings for a text document
 */
export type TextDocumentSettings = Omit<ConfigurationSettings, 'workingDirectory'>  & {
	silent: boolean;
	workingDirectory: DirectoryItem | undefined;
	library: ESLintModule | undefined;
	resolvedGlobalPackageManagerPath: string | undefined;
};

export namespace TextDocumentSettings {
	export function hasLibrary(settings: TextDocumentSettings): settings is (TextDocumentSettings & { library: ESLintModule }) {
		return settings.library !== undefined;
	}
}