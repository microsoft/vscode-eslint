/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

declare module 'vscode' {
	//#region https://github.com/microsoft/vscode/issues/106488

	export enum WorkspaceTrustState {
		/**
		 * The workspace is untrusted, and it will have limited functionality.
		 */
		Untrusted = 0,

		/**
		 * The workspace is trusted, and all functionality will be available.
		 */
		Trusted = 1,

		/**
		 * The initial state of the workspace.
		 *
		 * If trust will be required, users will be prompted to make a choice.
		 */
		Unknown = 2
	}

	/**
	 * The event data that is fired when the trust state of the workspace changes
	 */
	export interface WorkspaceTrustStateChangeEvent {
		/**
		 * Previous trust state of the workspace
		 */
		previousTrustState: WorkspaceTrustState;

		/**
		 * Current trust state of the workspace
		 */
		currentTrustState: WorkspaceTrustState;
	}

	export namespace workspace {
		/**
		 * The trust state of the current workspace
		 */
		export const trustState: WorkspaceTrustState;

		/**
		 * Prompt the user to chose whether to trust the current workspace
		 * @param message Optional message which would be displayed in the prompt
		 */
		export function requireWorkspaceTrust(message?: string): Thenable<WorkspaceTrustState>;

		/**
		 * Event that fires when the trust state of the current workspace changes
		 */
		export const onDidChangeWorkspaceTrustState: Event<WorkspaceTrustStateChangeEvent>;
	}

	//#endregion
}