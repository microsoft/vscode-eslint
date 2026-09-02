/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { workspace as Workspace, type TextDocument, type Uri } from 'vscode';

import { Validate } from './shared/settings';
import { Is } from './node-utils';

type ValidateItem = {
	language: string;
};

function isValidateItem(item: unknown): item is ValidateItem {
	return typeof item === 'object' && item !== null && 'language' in item && Is.string(item.language);
}

export type ValidateWorkspace = Pick<typeof Workspace, 'workspaceFolders' | 'getConfiguration' | 'getWorkspaceFolder'>;

export class Validator {

	private readonly probeFailed: Set<string> = new Set();

	public constructor(private readonly workspace: ValidateWorkspace) {
	}

	public clear(): void {
		this.probeFailed.clear();
	}

	public add(uri: Uri): void {
		this.probeFailed.add(uri.toString());
	}

	public check(textDocument: TextDocument): Validate {
		const config = this.workspace.getConfiguration('eslint', textDocument.uri);

		if (!config.get<boolean>('enable', true)) {
			return Validate.off;
		}

		if (textDocument.uri.scheme === 'untitled' && config.get<boolean>('ignoreUntitled', false)) {
			return Validate.off;
		}

		if (
			textDocument.uri.scheme !== 'untitled' &&
			config.get<boolean>('ignoreOutsideWorkspace', false) &&
			(this.workspace.workspaceFolders?.length ?? 0) > 0 &&
			this.workspace.getWorkspaceFolder(textDocument.uri) === undefined
		) {
			return Validate.off;
		}

		const languageId = textDocument.languageId;
		const validate = config.get<((ValidateItem | string)[]) | null>('validate', null);
		if (Array.isArray(validate)) {
			for (const item of validate) {
				if (Is.string(item) && item === languageId) {
					return Validate.on;
				} else if (isValidateItem(item) && item.language === languageId) {
					return Validate.on;
				}
			}
			return Validate.off;
		}

		if (this.probeFailed.has(textDocument.uri.toString())) {
			return Validate.off;
		}

		const probe: string[] | undefined = config.get<string[]>('probe', []);
		if (Array.isArray(probe)) {
			for (const item of probe) {
				if (item === languageId) {
					return Validate.probe;
				}
			}
		}

		return Validate.off;
	}
}
