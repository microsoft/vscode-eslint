
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';

import {
	workspace as Workspace, window as Window, languages as Languages, Uri, TextDocument, CodeActionContext, Diagnostic,
	Command, CodeAction, MessageItem, ConfigurationTarget, env as Env, CodeActionKind, WorkspaceConfiguration, NotebookCell, commands,
	ExtensionContext, LanguageStatusItem, LanguageStatusSeverity, DocumentFilter as VDocumentFilter
} from 'vscode';

import {
	LanguageClient, LanguageClientOptions, TransportKind, ErrorHandler, CloseAction, RevealOutputChannelOn, ServerOptions,
	DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, State, VersionedTextDocumentIdentifier, ExecuteCommandParams,
	ExecuteCommandRequest, ConfigurationParams, NotebookDocumentSyncRegistrationType, DiagnosticPullMode, DocumentDiagnosticRequest
} from 'vscode-languageclient/node';

import { LegacyDirectoryItem, Migration, PatternItem, ValidateItem } from './settings';
import { ExitCalled, NoConfigRequest, NoESLintLibraryRequest, OpenESLintDocRequest, ProbeFailedRequest, ShowOutputChannel, Status, StatusNotification, StatusParams } from './shared/customMessages';
import { CodeActionSettings, CodeActionsOnSaveMode, CodeActionsOnSaveOptions, CodeActionsOnSaveRules, ConfigurationSettings, DirectoryItem, ESLintOptions, ESLintSeverity, ModeItem, PackageManagers, RuleCustomization, RunValues, Validate } from './shared/settings';
import { convert2RegExp, Is, Semaphore, toOSPath, toPosixPath } from './node-utils';
import { pickFolder } from './vscode-utils';

export class Validator {

	private readonly probeFailed: Set<string> = new Set();

	public clear(): void {
		this.probeFailed.clear();
	}

	public add(uri: Uri): void {
		this.probeFailed.add(uri.toString());
	}

	public check(textDocument: TextDocument): Validate {
		const config = Workspace.getConfiguration('eslint', textDocument.uri);

		if (!config.get<boolean>('enable', true)) {
			return Validate.off;
		}

		if (textDocument.uri.scheme === 'untitled' && config.get<boolean>('ignoreUntitled', false)) {
			return Validate.off;
		}

		const languageId = textDocument.languageId;
		const validate = config.get<((ValidateItem | string)[]) | null>('validate', null);
		if (Array.isArray(validate)) {
			for (const item of validate) {
				if (Is.string(item) && item === languageId) {
					return Validate.on;
				} else if (ValidateItem.is(item) && item.language === languageId) {
					return Validate.on;
				}
			}
			return Validate.off;
		}

		if (this.probeFailed.has(textDocument.uri.toString())) {
			return Validate.off;
		}

		const probe: string[] | undefined = config.get<string[]>('probe');
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

type NoESLintState = {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
};

export namespace ESLintClient {

	function migrationFailed(client: LanguageClient, error: any): void {
		client.error(error.message ?? 'Unknown error', error);
		void Window.showErrorMessage('ESLint settings migration failed. Please see the ESLint output channel for further details', 'Open Channel').then((selected) => {
			if (selected === undefined) {
				return;
			}
			client.outputChannel.show();
		});

	}

	export async function migrateSettings(client: LanguageClient): Promise<void> {
		const folders = Workspace.workspaceFolders;
		if (folders === undefined) {
			void Window.showErrorMessage('ESLint settings can only be converted if VS Code is opened on a workspace folder.');
			return;
		}

		const folder = await pickFolder(folders, 'Pick a folder to convert its settings');
		if (folder === undefined) {
			return;
		}
		const migration = new Migration(folder.uri);
		migration.record();
		if (migration.needsUpdate()) {
			try {
				await migration.update();
			} catch (error) {
				migrationFailed(client, error);
			}
		}
	}

	interface TimeBudget {
		warn: number;
		error: number;
	}

	type PerformanceStatus = {
		firstReport: boolean;
		validationTime: number;
		fixTime: number;
		reported: number;
		acknowledged: boolean;
	};

	namespace PerformanceStatus {
		export const defaultValue: PerformanceStatus = { firstReport: true, validationTime: 0, fixTime: 0, reported: 0, acknowledged: false };
	}

	export function create(context: ExtensionContext, validator: Validator): [LanguageClient, () => void] {

		// Filters for client options
		const packageJsonFilter: VDocumentFilter = { scheme: 'file', pattern: '**/package.json' };
		const configFileFilter: VDocumentFilter = { scheme: 'file', pattern: '**/{.eslintr{c.js,c.yaml,c.yml,c,c.json},eslint.confi{g.js,g.mjs,g.cjs}}' };
		const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source.value, CodeActionKind.SourceFixAll.value, `${CodeActionKind.SourceFixAll.value}.eslint`, CodeActionKind.QuickFix.value]);

		// A map of documents synced to the server
		const syncedDocuments: Map<string, TextDocument> = new Map();
		// The actual ESLint client
		const client: LanguageClient = new LanguageClient('ESLint', createServerOptions(context.extensionUri), createClientOptions());

		// The default error handler.
		const defaultErrorHandler: ErrorHandler = client.createDefaultErrorHandler();
		// Whether the server call process.exit() which is intercepted and reported to
		// the client
		let serverCalledProcessExit: boolean = false;

		// A semaphore to ensure we are only running one migration at a time
		const migrationSemaphore: Semaphore<void> = new Semaphore<void>(1);
		// The actual migration code if any.
		let migration: Migration | undefined;
		// Whether migration should happen now
		let notNow: boolean = false;

		// The client's status bar item.
		const languageStatus: LanguageStatusItem = Languages.createLanguageStatusItem('eslint.languageStatusItem', []);
		let serverRunning: boolean | undefined;

		const starting = 'ESLint server is starting.';
		const running = 'ESLint server is running.';
		const stopped = 'ESLint server stopped.';
		languageStatus.name = 'ESLint';
		languageStatus.text = 'ESLint';
		languageStatus.command = { title: 'Open ESLint Output', command: 'eslint.showOutputChannel' };
		type StatusInfo = Omit<Omit<StatusParams, 'uri'>, 'validationTime'> & {
		};
		const documentStatus: Map<string, StatusInfo> = new Map();
		const performanceStatus: Map<string, PerformanceStatus> = new Map();

		// If the workspace configuration changes we need to update the synced documents since the
		// list of probe language type can change.
		context.subscriptions.push(Workspace.onDidChangeConfiguration(() => {
			validator.clear();
			for (const textDocument of syncedDocuments.values()) {
				if (validator.check(textDocument) === Validate.off) {
					const provider = client.getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error) => client.error(`Sending close notification failed.`, error));
				}
			}
			for (const textDocument of Workspace.textDocuments) {
				if (!syncedDocuments.has(textDocument.uri.toString()) && validator.check(textDocument) !== Validate.off) {
					const provider = client.getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error) => client.error(`Sending open notification failed.`, error));
				}
			}
		}));

		client.onNotification(ShowOutputChannel.type, () => {
			client.outputChannel.show();
		});

		client.onNotification(StatusNotification.type, (params) => {
			updateDocumentStatus(params);
		});

		client.onNotification(ExitCalled.type, (params) => {
			serverCalledProcessExit = true;
			client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
			void Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, { title: 'Open Output', id: 1}).then((value) => {
				if (value !== undefined && value.id === 1) {
					client.outputChannel.show();
				}
			});
		});

		client.onRequest(NoConfigRequest.type, (params) => {
			const document = Uri.parse(params.document.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(document);
			const fileLocation = document.fsPath;
			if (workspaceFolder) {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
					`Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			} else {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			}

			updateDocumentStatus({ uri: params.document.uri, state: Status.error });
			return {};
		});

		client.onRequest(NoESLintLibraryRequest.type, async (params) => {
			const key = 'noESLintMessageShown';
			const state = context.globalState.get<NoESLintState>(key, {});

			const uri: Uri = Uri.parse(params.source.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(uri);
			const packageManager = await getPackageManager(uri);
			const localInstall = {
				npm: 'npm install eslint',
				pnpm: 'pnpm install eslint',
				yarn: 'yarn add eslint',
			};
			const globalInstall = {
				npm: 'npm install -g eslint',
				pnpm: 'pnpm install -g eslint',
				yarn: 'yarn global add eslint'
			};
			interface ButtonItem extends MessageItem {
				id: number;
			}
			const outputItem: ButtonItem = {
				title: 'Go to output',
				id: 1
			};
			if (workspaceFolder) {
				client.info([
					'',
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					'',
					`To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
					`or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
					'',
					`Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`
				].filter((str => (str !== null))).join('\n'));

				if (state.workspaces === undefined) {
					state.workspaces = {};
				}
				if (!state.workspaces[workspaceFolder.uri.toString()]) {
					state.workspaces[workspaceFolder.uri.toString()] = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			} else {
				client.info([
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					`To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
					'You need to reopen VS Code after installing eslint.',
				].filter((str => (str !== null))).join('\n'));

				if (!state.global) {
					state.global = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			}
			return {};
		});

		client.onRequest(OpenESLintDocRequest.type, async (params) => {
			await commands.executeCommand('vscode.open', Uri.parse(params.url));
			return {};
		});

		client.onRequest(ProbeFailedRequest.type, (params) => {
			const uri = client.protocol2CodeConverter.asUri(params.textDocument.uri);
			validator.add(uri);
			const closeFeature = client.getFeature(DidCloseTextDocumentNotification.method);
			const diagnosticsFeature = client.getFeature(DocumentDiagnosticRequest.method);
			for (const document of Workspace.textDocuments) {
				if (document.uri.toString() === uri.toString()) {
					closeFeature.getProvider(document)?.send(document).catch((error) => client.error(`Sending close notification failed`, error));
					diagnosticsFeature?.getProvider(document)?.forget(document);
				}
			}
		});

		const notebookFeature = client.getFeature(NotebookDocumentSyncRegistrationType.method);
		if (notebookFeature !== undefined) {
			notebookFeature.register({
				id: String(Date.now()),
				registerOptions: {
					notebookSelector: [{
						notebook: { scheme: 'file' },
						// We dynamically filter using the filterCells callback.
						// To force the filtering match all cells for now.
						// See also https://github.com/microsoft/vscode-languageserver-node/issues/1017
						cells: [ { language: '*' } ]
					}]
				}
			});
		}

		client.onDidChangeState((event) => {
			if (event.newState === State.Starting) {
				client.info(starting);
				serverRunning = undefined;
			} else if (event.newState === State.Running) {
				client.info(running);
				serverRunning = true;
			} else {
				client.info(stopped);
				serverRunning = false;
			}
			updateStatusBar(undefined);
		});

		context.subscriptions.push(
			Window.onDidChangeActiveTextEditor(() => {
				updateStatusBar(undefined);
			}),
			Workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				documentStatus.delete(uri);
				updateLanguageStatusSelector();
				updateStatusBar(undefined);
			}),
			commands.registerCommand('eslint.executeAutofix', async () => {
				const textEditor = Window.activeTextEditor;
				if (!textEditor) {
					return;
				}
				const textDocument: VersionedTextDocumentIdentifier = {
					uri: textEditor.document.uri.toString(),
					version: textEditor.document.version
				};
				const params: ExecuteCommandParams = {
					command: 'eslint.applyAllFixes',
					arguments: [textDocument]
				};
				await client.start();
				client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
					void Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
				});
			})
		);

		return [client, acknowledgePerformanceStatus];

		function createServerOptions(extensionUri: Uri): ServerOptions {
			const serverModule = Uri.joinPath(extensionUri, 'server', 'out', 'eslintServer.js').fsPath;
			const eslintConfig = Workspace.getConfiguration('eslint');
			const debug = sanitize(eslintConfig.get<boolean>('debug', false) ?? false, 'boolean', false);
			const runtime = sanitize(eslintConfig.get<string | null>('runtime', null) ?? undefined, 'string', undefined);
			const execArgv = sanitize(eslintConfig.get<string[] | null>('execArgv', null) ?? undefined, 'string', undefined);
			const nodeEnv = sanitize(eslintConfig.get<string | null>('nodeEnv', null) ?? undefined, 'string', undefined);

			let env: { [key: string]: string | number | boolean } | undefined;
			if (debug) {
				env = env || {};
				env.DEBUG = 'eslint:*,-eslint:code-path,eslintrc:*';
			}
			if (nodeEnv !== undefined) {
				env = env || {};
				env.NODE_ENV = nodeEnv;
			}
			const debugArgv = ['--nolazy', '--inspect=6011'];
			const result: ServerOptions = {
				run: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv, cwd: process.cwd(), env } },
				debug: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv: execArgv !== undefined ? execArgv.concat(debugArgv) : debugArgv, cwd: process.cwd(), env } }
			};
			return result;
		}

		function sanitize<T, D>(value: T, type: 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined', def: D): T | D {
			if (Array.isArray(value)) {
				return value.filter(item => typeof item === type) as unknown as T;
			} else if (typeof value !== type) {
				return def;
			}
			return value;
		}

		function createClientOptions(): LanguageClientOptions {
			const clientOptions: LanguageClientOptions = {
				documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
				revealOutputChannelOn: RevealOutputChannelOn.Never,
				initializationOptions: {
				},
				progressOnInitialization: true,
				synchronize: {
					fileEvents: [
						Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.cjs,c.yaml,c.yml,c,c.json}'),
						Workspace.createFileSystemWatcher('**/eslint.config.js'),
						Workspace.createFileSystemWatcher('**/.eslintignore'),
						Workspace.createFileSystemWatcher('**/package.json')
					]
				},
				initializationFailedHandler: (error) => {
					client.error('Server initialization failed.', error);
					client.outputChannel.show(true);
					return false;
				},
				errorHandler: {
					error: (error, message, count) => {
						return defaultErrorHandler.error(error, message, count);
					},
					closed: () => {
						if (serverCalledProcessExit) {
							return { action: CloseAction.DoNotRestart };
						}
						return defaultErrorHandler.closed();
					}
				},
				diagnosticPullOptions: {
					onChange: true,
					onSave: true,
					onFocus: true,
					filter: (document, mode) => {
						const config = Workspace.getConfiguration('eslint', document);
						const run = config.get<RunValues>('run', 'onType');
						if (mode === DiagnosticPullMode.onType && run !== 'onType') {
							return true;
						} else if (mode === DiagnosticPullMode.onSave && run !== 'onSave') {
							return true;
						}
						return validator.check(document) === Validate.off;
					},
					onTabs: false
				},
				middleware: {
					didOpen: async (document, next) => {
						if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || validator.check(document) !== Validate.off) {
							const result = next(document);
							syncedDocuments.set(document.uri.toString(), document);

							return result;
						}
					},
					didChange: async (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						}
					},
					willSave: async (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						}
					},
					willSaveWaitUntil: (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						} else {
							return Promise.resolve([]);
						}
					},
					didSave: async (document, next) => {
						if (syncedDocuments.has(document.uri.toString())) {
							return next(document);
						}
					},
					didClose: async (document, next) => {
						const uri = document.uri.toString();
						if (syncedDocuments.has(uri)) {
							syncedDocuments.delete(uri);
							return next(document);
						}
					},
					notebooks: {
						didOpen: (notebookDocument, cells, next) => {
							const result = next(notebookDocument, cells);
							for (const cell of cells) {
								syncedDocuments.set(cell.document.uri.toString(), cell.document);
							}
							return result;
						},
						didChange: (event, next) => {
							if (event.cells?.structure?.didOpen !== undefined) {
								for (const open of event.cells.structure.didOpen) {
									syncedDocuments.set(open.document.uri.toString(), open.document);
								}
							}
							if (event.cells?.structure?.didClose !== undefined) {
								for (const closed of event.cells.structure.didClose) {
									syncedDocuments.delete(closed.document.uri.toString());
								}
							}
							return next(event);
						},
						didClose: (document, cells, next) => {
							for (const cell of cells) {
								const key = cell.document.uri.toString();
								syncedDocuments.delete(key);
							}
							return next(document, cells);
						}
					},
					provideCodeActions: async (document, range, context, token, next): Promise<(Command | CodeAction)[] | null | undefined> => {
						if (!syncedDocuments.has(document.uri.toString())) {
							return [];
						}
						if (context.only !== undefined && !supportedQuickFixKinds.has(context.only.value)) {
							return [];
						}
						if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
							return [];
						}
						const eslintDiagnostics: Diagnostic[] = [];
						for (const diagnostic of context.diagnostics) {
							if (diagnostic.source === 'eslint') {
								eslintDiagnostics.push(diagnostic);
							}
						}
						if (context.only === undefined && eslintDiagnostics.length === 0) {
							return [];
						}
						const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics });
						const start = Date.now();
						const result = await next(document, range, newContext, token);
						if (context.only?.value.startsWith('source.fixAll')) {
							let performanceInfo = performanceStatus.get(document.languageId);
							if (performanceInfo === undefined) {
								performanceInfo = PerformanceStatus.defaultValue;
								performanceStatus.set(document.languageId, performanceInfo);
							} else {
								performanceInfo.firstReport = false;
							}
							performanceInfo.fixTime = Date.now() - start;
							updateStatusBar(document);
						}
						return result;
					},
					workspace: {
						didChangeWatchedFile: (event, next) => {
							validator.clear();
							return next(event);
						},
						didChangeConfiguration: async (sections, next) => {
							if (migration !== undefined && (sections === undefined || sections.length === 0)) {
								migration.captureDidChangeSetting(() => {
									return next(sections);
								});
							} else {
								return next(sections);
							}
						},
						configuration: (params) => {
							return readConfiguration(params);
						}
					}
				},
				notebookDocumentOptions: {
					filterCells: (_notebookDocument, cells) => {
						const result: NotebookCell[] = [];
						for (const cell of cells) {
							const document = cell.document;
							if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || validator.check(document) !== Validate.off) {
								result.push(cell);
							}
						}
						return result;
					}
				}
			};
			return clientOptions;
		}

		async function getPackageManager(uri: Uri) {
			const userProvidedPackageManager:PackageManagers = Workspace.getConfiguration('eslint', uri).get('packageManager', 'npm');
			const detectedPackageManager = await commands.executeCommand<PackageManagers>('npm.packageManager');

			if (userProvidedPackageManager === detectedPackageManager) {
				return detectedPackageManager;
			}
			client.warn(`Detected package manager(${detectedPackageManager}) differs from the one in the deprecated packageManager setting(${userProvidedPackageManager}). We will honor this setting until it is removed.`, {}, true);
			return userProvidedPackageManager;
		}

		async function readConfiguration(params: ConfigurationParams): Promise<(ConfigurationSettings | null)[]> {
			if (params.items === undefined) {
				return [];
			}
			const result: (ConfigurationSettings | null)[] = [];
			for (const item of params.items) {
				if (item.section || !item.scopeUri) {
					result.push(null);
					continue;
				}
				const resource = client.protocol2CodeConverter.asUri(item.scopeUri);
				const textDocument = getTextDocument(resource);
				const config = Workspace.getConfiguration('eslint', textDocument ?? resource);
				const workspaceFolder = resource.scheme === 'untitled'
					? Workspace.workspaceFolders !== undefined ? Workspace.workspaceFolders[0] : undefined
					: Workspace.getWorkspaceFolder(resource);
				await migrationSemaphore.lock(async () => {
					const globalMigration = Workspace.getConfiguration('eslint').get('migration.2_x', 'on');
					if (notNow === false && globalMigration === 'on') {
						try {
							migration = new Migration(resource);
							migration.record();
							interface Item extends MessageItem {
								id: 'yes' | 'no' | 'readme' | 'global' | 'local';
							}
							if (migration.needsUpdate()) {
								const folder = workspaceFolder?.name;
								const file = path.basename(resource.fsPath);
								const selected = await Window.showInformationMessage<Item>(
									[
										`The ESLint 'autoFixOnSave' setting needs to be migrated to the new 'editor.codeActionsOnSave' setting`,
										folder !== undefined ? `for the workspace folder: ${folder}.` : `for the file: ${file}.`,
										`For compatibility reasons the 'autoFixOnSave' remains and needs to be removed manually.`,
										`Do you want to migrate the setting?`
									].join(' '),
									{ modal: true},
									{ id: 'yes', title: 'Yes'},
									{ id: 'global', title: 'Never migrate Settings' },
									{ id: 'readme', title: 'Open Readme' },
									{ id: 'no', title: 'Not now', isCloseAffordance: true }
								);
								if (selected !== undefined) {
									if (selected.id === 'yes') {
										try {
											await migration.update();
										} catch (error) {
											migrationFailed(client, error);
										}
									} else if (selected.id === 'no') {
										notNow = true;
									} else if (selected.id === 'global') {
										await config.update('migration.2_x', 'off', ConfigurationTarget.Global);
									} else if (selected.id === 'readme') {
										notNow = true;
										void Env.openExternal(Uri.parse('https://github.com/microsoft/vscode-eslint#settings-migration'));
									}
								}
							}
						} finally {
							migration = undefined;
						}
					}
				});
				const useFlatConfig = config.get<boolean | null>('useFlatConfig', null);
				const settings: ConfigurationSettings = {
					validate: Validate.off,
					packageManager: config.get<PackageManagers>('packageManager', 'npm'),
					useESLintClass: config.get<boolean>('useESLintClass', false),
					useFlatConfig: useFlatConfig === null ? undefined : useFlatConfig,
					experimental: {
						useFlatConfig: config.get<boolean>('experimental.useFlatConfig', false),
					},
					codeActionOnSave: {
						mode: CodeActionsOnSaveMode.all
					},
					format: false,
					quiet: config.get<boolean>('quiet', false),
					onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
					options: config.get<ESLintOptions>('options', {}),
					rulesCustomizations: getRuleCustomizations(config, resource),
					run: config.get<RunValues>('run', 'onType'),
					problems: {
						shortenToSingleLine: config.get<boolean>('problems.shortenToSingleLine', false),
					},
					nodePath: config.get<string | undefined>('nodePath', undefined) ?? null,
					workingDirectory: undefined,
					workspaceFolder: undefined,
					codeAction: {
						disableRuleComment: config.get<CodeActionSettings['disableRuleComment']>('codeAction.disableRuleComment', { enable: true, location: 'separateLine' as const, commentStyle: 'line' as const }),
						showDocumentation: config.get<CodeActionSettings['showDocumentation']>('codeAction.showDocumentation', { enable: true })
					}
				};
				const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri);
				if (document === undefined) {
					result.push(settings);
					continue;
				}
				if (config.get<boolean>('enabled', true)) {
					settings.validate = validator.check(document);
				}
				if (settings.validate !== Validate.off) {
					settings.format = !!config.get<boolean>('format.enable', false);
					settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(config.get<CodeActionsOnSaveMode>('codeActionsOnSave.mode', CodeActionsOnSaveMode.all));
					settings.codeActionOnSave.rules = CodeActionsOnSaveRules.from(config.get<string[] | null>('codeActionsOnSave.rules', null));
					settings.codeActionOnSave.options = CodeActionsOnSaveOptions.from(config.get<ESLintOptions | null>('codeActionsOnSave.options', null));
				}
				if (workspaceFolder !== undefined) {
					settings.workspaceFolder = {
						name: workspaceFolder.name,
						uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
					};
				}
				const workingDirectories = config.get<(string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined>('workingDirectories', undefined);
				if (Array.isArray(workingDirectories)) {
					let workingDirectory: ModeItem | DirectoryItem | undefined = undefined;
					const workspaceFolderPath = workspaceFolder && workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
					for (const entry of workingDirectories) {
						let directory: string | undefined;
						let pattern: string | undefined;
						let noCWD = false;
						if (Is.string(entry)) {
							directory = entry;
						} else if (LegacyDirectoryItem.is(entry)) {
							directory = entry.directory;
							noCWD = !entry.changeProcessCWD;
						} else if (DirectoryItem.is(entry)) {
							directory = entry.directory;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (PatternItem.is(entry)) {
							pattern = entry.pattern;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (ModeItem.is(entry)) {
							workingDirectory = entry;
							continue;
						}

						let itemValue: string | undefined;
						if (directory !== undefined || pattern !== undefined) {
							const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
							if (filePath !== undefined) {
								if (directory !== undefined) {
									directory = toOSPath(directory);
									if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
										directory = path.join(workspaceFolderPath, directory);
									}
									if (directory.charAt(directory.length - 1) !== path.sep) {
										directory = directory + path.sep;
									}
									if (filePath.startsWith(directory)) {
										itemValue = directory;
									}
								} else if (pattern !== undefined && pattern.length > 0) {
									if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
										pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern);
									}
									if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
										pattern = pattern + path.posix.sep;
									}
									const regExp: RegExp | undefined = convert2RegExp(pattern);
									if (regExp !== undefined) {
										const match = regExp.exec(filePath);
										if (match !== null && match.length > 0) {
											itemValue = match[0];
										}
									}
								}
							}
						}
						if (itemValue !== undefined) {
							if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
								workingDirectory = { directory: itemValue, '!cwd': noCWD };
							} else {
								if (workingDirectory.directory.length < itemValue.length) {
									workingDirectory.directory = itemValue;
									workingDirectory['!cwd'] = noCWD;
								}
							}
						}
					}
					settings.workingDirectory = workingDirectory;
				}
				result.push(settings);
			}
			return result;
		}

		function parseRulesCustomizations(rawConfig: unknown): RuleCustomization[] {
			if (!rawConfig || !Array.isArray(rawConfig)) {
				return [];
			}

			return rawConfig.map(rawValue => {
				if (typeof rawValue.severity === 'string' && typeof rawValue.rule === 'string') {
					if (typeof rawValue.fixable === 'boolean') {
						return {
							severity: rawValue.severity,
							rule: rawValue.rule,
							fixable: rawValue.fixable
						};
					} else {
						return {
							severity: rawValue.severity,
							rule: rawValue.rule,
						};
					}
				}

				return undefined;
			}).filter((value): value is RuleCustomization => !!value);
		}

		function getRuleCustomizations(config: WorkspaceConfiguration, uri: Uri): RuleCustomization[] {
			let customizations: RuleCustomization[] | undefined = undefined;
			if (uri.scheme === 'vscode-notebook-cell') {
				customizations = config.get<RuleCustomization[] | undefined>('notebooks.rules.customizations', undefined);
			}
			if (customizations === undefined || customizations === null) {
				customizations = config.get<RuleCustomization[] | undefined>('rules.customizations');
			}
			return parseRulesCustomizations(customizations);
		}

		function getTextDocument(uri: Uri): TextDocument | undefined {
			return syncedDocuments.get(uri.toString());
		}

		function updateDocumentStatus(params: StatusParams): void {
			const needsSelectorUpdate = !documentStatus.has(params.uri);
			documentStatus.set(params.uri, { state: params.state });
			if (needsSelectorUpdate) {
				updateLanguageStatusSelector();
			}
			const textDocument = syncedDocuments.get(params.uri);
			if (textDocument !== undefined) {
				let performanceInfo = performanceStatus.get(textDocument.languageId);
				if (performanceInfo === undefined) {
					performanceInfo = PerformanceStatus.defaultValue;
					performanceStatus.set(textDocument.languageId, performanceInfo);
				} else {
					performanceInfo.firstReport = false;
				}
				performanceInfo.validationTime = params.validationTime ?? 0;
			}
			updateStatusBar(textDocument);
		}

		function updateLanguageStatusSelector(): void {
			const selector: VDocumentFilter[] = [];
			for (const key of documentStatus.keys()) {
				const uri: Uri = Uri.parse(key);
				const document = syncedDocuments.get(key);
				const filter: VDocumentFilter = {
					scheme: uri.scheme,
					pattern: uri.fsPath,
					language: document?.languageId
				};
				selector.push(filter);
			}
			languageStatus.selector = selector;
		}

		function acknowledgePerformanceStatus(): void {
			const activeTextDocument = Window.activeTextEditor?.document;
			if (activeTextDocument === undefined) {
				return;
			}
			const performanceInfo = performanceStatus.get(activeTextDocument.languageId);
			if (performanceInfo === undefined || performanceInfo.reported === 0) {
				return;
			}
			performanceInfo.acknowledged = true;
			updateStatusBar(activeTextDocument);
		}

		function updateStatusBar(textDocument: TextDocument | undefined) {
			const activeTextDocument = textDocument ?? Window.activeTextEditor?.document;
			if (activeTextDocument === undefined || serverRunning === false) {
				return;
			}
			const performanceInfo = performanceStatus.get(activeTextDocument.languageId);
			const statusInfo = documentStatus.get(activeTextDocument.uri.toString()) ?? { state: Status.ok};

			let validationBudget = Workspace.getConfiguration('eslint', activeTextDocument).get<TimeBudget>('timeBudget.onValidation', { warn: 4000, error: 8000 });
			if (validationBudget.warn < 0 || validationBudget.error < 0) {
				validationBudget = {
					warn: validationBudget.warn < 0 ? Number.MAX_VALUE : validationBudget.warn,
					error: validationBudget.error < 0 ? Number.MAX_VALUE : validationBudget.error
				};
			}
			let fixesBudget = Workspace.getConfiguration('eslint', activeTextDocument).get<TimeBudget>('timeBudget.onFixes', { warn: 3000, error: 6000 });
			if (fixesBudget.warn < 0 || fixesBudget.error < 0) {
				fixesBudget = {
					warn: fixesBudget.warn < 0 ? Number.MAX_VALUE : fixesBudget.warn,
					error: fixesBudget.error < 0 ? Number.MAX_VALUE : fixesBudget.error
				};
			}

			let severity: LanguageStatusSeverity = LanguageStatusSeverity.Information;
			const [timeTaken, detail, message, timeBudget] = function(): [number, string | undefined, string, TimeBudget] {
				if (performanceInfo === undefined || performanceInfo.firstReport || performanceInfo.acknowledged) {
					return [-1, undefined, '', { warn: 0, error: 0 }];
				}
				if ((performanceInfo.fixTime) > (performanceInfo.validationTime)) {
					const timeTaken = Math.max(performanceInfo.fixTime, performanceInfo.reported);
					return [
						timeTaken,
						timeTaken > fixesBudget.warn ? `Computing fixes took ${timeTaken}ms` :  undefined,
						`Computing fixes during save for file ${activeTextDocument.uri.toString()} during save took ${timeTaken}ms. Please check the ESLint rules for performance issues.`,
						fixesBudget
					];
				} else if ((performanceInfo.validationTime) > 0) {
					const timeTaken = Math.max(performanceInfo.validationTime, performanceInfo.reported);
					return [
						timeTaken,
						timeTaken > validationBudget.warn ? `Validation took ${timeTaken}ms` :  undefined,
						`Linting file ${activeTextDocument.uri.toString()} took ${timeTaken}ms. Please check the ESLint rules for performance issues.`,
						validationBudget
					];
				}
				return [-1, undefined, '', { warn: 0, error: 0 }];
			}();

			switch (statusInfo.state) {
				case Status.ok:
					break;
				case Status.warn:
					severity = LanguageStatusSeverity.Warning;
					break;
				case Status.error:
					severity = LanguageStatusSeverity.Error;
					break;
			}
			if (severity === LanguageStatusSeverity.Information && timeTaken > timeBudget.warn) {
				severity = LanguageStatusSeverity.Warning;
			}
			if (severity === LanguageStatusSeverity.Warning && timeTaken > timeBudget.error) {
				severity = LanguageStatusSeverity.Error;
			}
			if (timeTaken > timeBudget.warn && performanceInfo !== undefined) {
				if (timeTaken > performanceInfo.reported) {
					if (timeTaken > timeBudget.error) {
						client.error(message);
					} else {
						client.warn(message);
					}
				}
			}

			if (detail !== undefined && languageStatus.detail !== detail) {
				 languageStatus.detail = detail;
			}
			if (languageStatus.severity !== severity) {
				languageStatus.severity = severity;
			}
			if (performanceInfo !== undefined) {
				performanceInfo.reported = Math.max(performanceInfo.reported, timeTaken);
			}
		}
	}
}
