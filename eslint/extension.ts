import * as path from 'path';
import { workspace, Disposable } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, RequestType } from 'vscode-languageclient';

export function activate(subscriptions: Disposable[]) {

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule },
		debug: { module: serverModule, options: debugOptions}
	};

	let clientOptions: LanguageClientOptions = {
		languageSelector: ['javascript', 'javascriptreact'],
		synchronize: {
			configurationSection: 'eslint',
			fileEvents: workspace.createFileSystemWatcher('**/.eslintrc')
		}
	}

	let client = new LanguageClient('ES Linter', serverOptions, clientOptions);
	subscriptions.push(new SettingMonitor(client, 'eslint.enable').start());
}