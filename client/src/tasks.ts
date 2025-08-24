/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import { Disposable } from 'vscode-languageclient';

import { findEslint } from './node-utils';

/**
 * A special task definition for ESLint tasks
 */
interface EslintTaskDefinition extends vscode.TaskDefinition {
}


class FolderTaskProvider {
	constructor(private _workspaceFolder: vscode.WorkspaceFolder) {
	}

	public get workspaceFolder(): vscode.WorkspaceFolder {
		return this._workspaceFolder;
	}

	public isEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('eslint', this._workspaceFolder.uri);
		return config.get<boolean>('lintTask.enable', false) ?? config.get<boolean>('provideLintTask', false);
	}

	public start(): void {
	}

	public dispose(): void {
	}

	public async getTask(): Promise<vscode.Task | undefined> {
		const rootPath = this._workspaceFolder.uri.scheme === 'file' ? this._workspaceFolder.uri.fsPath : undefined;
		if (!rootPath) {
			return undefined;
		}
		try {
			const kind: EslintTaskDefinition = {
				type: 'eslint'
			};

			const options: vscode.ShellExecutionOptions = { cwd: this.workspaceFolder.uri.fsPath };
			const config = vscode.workspace.getConfiguration('eslint', this._workspaceFolder.uri);
			const lintTaskOptions= config.get<string>('lintTask.options', '.');

			const eslintCommands: string[] = [];
			for (const workingDirectory of this.workingDirectories()) {
				const eslint = await findEslint(workingDirectory);
				eslintCommands.push(`pushd ${workingDirectory} && ${eslint} ${lintTaskOptions} && popd`);
			}
			return new vscode.Task(
				kind, this.workspaceFolder,
				'lint whole folder', 'eslint', new vscode.ShellExecution(eslintCommands.join(' && '), options),
				'$eslint-stylish'
			);
		} catch (error) {
			return undefined;
		}
	}

	private workingDirectories() : string []{
		return vscode.workspace.getConfiguration('eslint', this._workspaceFolder.uri).get('workingDirectories', undefined) || ['.'];
	}
}

/**
 * A task provider that adds ESLint checking tasks.
 */
export class TaskProvider {

	/**
	 * A Disposable to unregister the task provider inside
	 * VS Code.
	 */
	private taskProvider: vscode.Disposable | undefined;

	/**
	 * The actual providers per workspace folder.
	 */
	private readonly providers: Map<string, FolderTaskProvider>;

	/**
	 * A disposable to unregister event listeners
	 */
	private disposable: Disposable | undefined;

	constructor() {
		this.providers = new Map();
	}

	public start(): void {
		const folders = vscode.workspace.workspaceFolders;
		if (folders !== undefined) {
			this.updateWorkspaceFolders(folders, []);
		}

		const disposables: vscode.Disposable[] = [];
		disposables.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => this.updateWorkspaceFolders(event.added, event.removed)));
		disposables.push(vscode.workspace.onDidChangeConfiguration(this.updateConfiguration, this));
		this.disposable = vscode.Disposable.from(...disposables);
	}

	public dispose(): void {
		if (this.taskProvider !== undefined) {
			this.taskProvider.dispose();
			this.taskProvider = undefined;
		}
		if (this.disposable !== undefined) {
			this.disposable.dispose();
			this.disposable = undefined;
		}
		this.providers.clear();
	}

	/**
	 * The workspace folders have changed.
	 */
	private updateWorkspaceFolders(added: ReadonlyArray<vscode.WorkspaceFolder>, removed: ReadonlyArray<vscode.WorkspaceFolder>): void {
		for (const remove of removed) {
			const provider = this.providers.get(remove.uri.toString());
			if (provider) {
				provider.dispose();
				this.providers.delete(remove.uri.toString());
			}
		}
		for (const add of added) {
			const provider = new FolderTaskProvider(add);
			if (provider.isEnabled()) {
				this.providers.set(add.uri.toString(), provider);
				provider.start();
			}
		}
		this.updateProvider();
	}

	/**
	 * The configuration has changed.
	 */
	private updateConfiguration(): void {
		for (const detector of this.providers.values()) {
			if (!detector.isEnabled()) {
				detector.dispose();
				this.providers.delete(detector.workspaceFolder.uri.toString());
			}
		}
		const folders = vscode.workspace.workspaceFolders;
		if (folders) {
			for (const folder of folders) {
				if (!this.providers.has(folder.uri.toString())) {
					const provider = new FolderTaskProvider(folder);
					if (provider.isEnabled()) {
						this.providers.set(folder.uri.toString(), provider);
						provider.start();
					}
				}
			}
		}
		this.updateProvider();
	}

	private updateProvider(): void {
		if (!this.taskProvider && this.providers.size > 0) {
			this.taskProvider = vscode.tasks.registerTaskProvider('eslint', {
				provideTasks: () => {
					return this.getTasks();
				},
				resolveTask(_task: vscode.Task): vscode.Task | undefined {
					return undefined;
				}
			});
		} else if (this.taskProvider && this.providers.size === 0) {
			this.taskProvider.dispose();
			this.taskProvider = undefined;
		}
	}

	private async getTasks(): Promise<vscode.Task[]> {
		if (this.providers.size === 0) {
			return [];
		} else {
			const promises: Promise<vscode.Task | undefined>[] = [];
			for (const provider of this.providers.values()) {
				promises.push(provider.getTask());
			}
			const values = await Promise.all(promises);
			return values.filter<vscode.Task>((value): value is vscode.Task => { return value !== undefined; });
		}
	}
}