/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { commands, window, workspace, Disposable, Position, Range, TextDocument, TextEditor, Uri } from 'vscode';
import { LanguageClient } from 'vscode-languageclient';
import { ESLintAutofixRequest, ESLintAutofixParams, ESLintAutofixResult } from './protocol';

/**
 * The controller of ESLint Autofix.
 *
 * This monitors actions saving documents then executes Autofix.
 * And this monitors "eslint.executeAutofix" commands then executes Autofix.
 *
 * This sends "ESLintAutofixRequest" request to the server to execute Autofix.
 * Then applies the result to documents.
 */
export default class ESLintAutofixController {
	private disposable: Disposable;
	private executingFlags: Map<string, boolean>;

	/**
	 * @param client - An interface which is used to send "ESLintAutofixRequest" request to the server.
	 */
	constructor(private client: LanguageClient) {
		this.executingFlags = new Map<string, boolean>();
	}

	/**
	 * Start listening events.
	 */
	start(): Disposable {
		this.disposable = Disposable.from(
			workspace.onDidSaveTextDocument(this.onSaved, this),
			commands.registerTextEditorCommand("eslint.executeAutofix", this.onExecute, this)
		);
		return this;
	}

	/**
	 * Stop listening events.
	 */
	dispose(): void {
		if (this.disposable != null) {
			this.disposable.dispose();
			this.disposable = null;
		}
	}

	/**
	 * This would be called by DidSaveTextDocument event.
	 * Then if the document is "javascript" or "javascriptreact", this executes Autofix.
	 *
	 * - If "eslint.enable" or "eslint.enableAutofixOnSave" is "false", the server does nothing.
	 * - If the document is hidden, the server does write the result of Autofix to the file directly.
	 */
	private onSaved(document: TextDocument): void {
		if (document.languageId.startsWith("javascript")) {
			const editor = window.visibleTextEditors.find(e => e.document === document);
			this.executeAutofix(document, editor, true);
		}
	}

	/**
	 * This would be called by "eslint.executeAutofix" command.
	 * Then if the document is "javascript" or "javascriptreact", this executes Autofix.
	 *
	 * - If "eslint.enable" is "false", the server does nothing.
	 */
	private onExecute(editor: TextEditor): void {
		const document = editor.document;

		if (document.languageId.startsWith("javascript")) {
			this.executeAutofix(document, editor, false);
		}
	}

	/**
	 * Execute Autofix on a given document.
	 *
	 * @param document - A document to execute Autofix.
	 * @param editor - An editor that the document is staying.
	 * @param onSaved - A flag to indicate that this was called by a save action.
	 */
	private executeAutofix(document: TextDocument, editor: TextEditor, onSaved: boolean): void {
		if (this.client.needsStart()) {
			console.log("executeAutofix: skipped because the client hasn't started yet.");
			return;
		}

		const uri = String(document.uri);
		const hidden = editor == null;

		// Skip if it's recursively.
		if (this.executingFlags.get(uri)) {
			console.log("executeAutofix: skipped because recursively.");
			return;
		}
		this.executingFlags.set(uri, true);

		console.log("executeAutofix: started " + document.uri.fsPath);

		// Send an autofix request to the server.
		this.client.sendRequest(ESLintAutofixRequest.type, {
			uri: uri,
			hidden: hidden,
			onSaved: onSaved
		}).then(result => {
			// If "hidden" is "true", the server wrote the result to the file directly.
			// Or if there are no change of Autofix then "result.fixedContent" is null.
			// In those case, do nothing here.
			if (hidden || result.fixedContent == null) {
				return true;
			}
			if (String(editor.document.uri) !== uri) {
				return false;
			}

			// Replace whole document with the autofix result.
			return editor.edit(mutator => {
				const wholeRange = editor.document.validateRange(new Range(
					new Position(0, 0),
					new Position(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
				));
				mutator.replace(wholeRange, result.fixedContent);
			});
		}).then(result => {
			// If the trigger is "didSaveTextDocument", the document got dirty as a result of this edit.
			// So it need to save the document again.
			// Though the save action triggers Autofix recursively, it would be skipped.
			if (result && onSaved && document.isDirty) {
				return document.save();
			}
			return result;
		}).then(
			(result) => {
				this.executingFlags.set(uri, false);
				if (!result) {
					window.showErrorMessage(
						"Failed to apply the result of Autofix: " +
						document.uri.fsPath
					);
				}
				console.log("executeAutofix: done " + document.uri.fsPath);
			},
			(err) => {
				this.executingFlags.set(uri, false);
				window.showErrorMessage(
					err && err.message ||
					"Failed to execute Autofix: " + document.uri.fsPath
				);
				console.log("executeAutofix: done " + document.uri.fsPath);
			}
		);
	}
}
