/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { QuickPickItem, window, WorkspaceFolder } from 'vscode';

interface WorkspaceFolderItem extends QuickPickItem {
	folder: WorkspaceFolder;
}

/**
 * Picks a folder from a list of workspace folders.
 */
export async function pickFolder(folders: ReadonlyArray<WorkspaceFolder>, placeHolder: string): Promise<WorkspaceFolder | undefined> {
	if (folders.length === 1) {
		return Promise.resolve(folders[0]);
	}

	const selected = await window.showQuickPick(
		folders.map<WorkspaceFolderItem>((folder) => { return { label: folder.name, description: folder.uri.fsPath, folder: folder }; }),
		{ placeHolder: placeHolder }
	);
	if (selected === undefined) {
		return undefined;
	}
	return selected.folder;
}