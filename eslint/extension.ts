import * as path from 'path';
import { workspace, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, RequestType } from 'vscode-languageclient';

export function activate(context: ExtensionContext) {

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule },
		debug: { module: serverModule, options: debugOptions}
	};

	let clientOptions: LanguageClientOptions = {
		documentSelector: ['javascript', 'javascriptreact'],
		synchronize: {
			configurationSection: 'eslint',
			fileEvents: workspace.createFileSystemWatcher('**/.eslintrc')
		}
	}

	let client = new LanguageClient('ES Linter', serverOptions, clientOptions);
	context.subscriptions.push(new SettingMonitor(client, 'eslint.enable').start());
}