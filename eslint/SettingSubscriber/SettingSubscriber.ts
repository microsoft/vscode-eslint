'use strict';

import { Disposable, workspace, WorkspaceConfiguration } from 'vscode';

interface Setting {
	name: string,
	value: any
}

interface Subscription {
	callback: Function,
	settings?: string[]
}

export class SettingSubscriber {

	private changeConfigurationHandler: Disposable;
	private currentSettings: WorkspaceConfiguration;
	private section: string;
	private subscriptions: Subscription[] = [];

	constructor (section: string) {
		this.currentSettings = workspace.getConfiguration(section);
		this.changeConfigurationHandler = workspace.onDidChangeConfiguration(() => this.configChangeHandler());
		this.section = section;
	}

	/**
	 * Subscribes to settings changes for section
	 * callback will be invoked if settings for this section have changed. If an array of settings
	 * has been passed in (optional), the callback will only fire if one of those settings have
	 * changed.
	 */
	public subscribe (callback: Function, settings?: string[]): Disposable {
		const subscription: Subscription = { callback };
		if (settings) subscription.settings = settings;

		this.subscriptions.push(subscription);

		return { dispose: this.dispose };
	}

	private configChangeHandler () {
		const changedSettings = this.getSectionSettingChanges();

		this.subscriptions.forEach(({ callback, settings }) => {
			let params = changedSettings;
			// If the callback is only subscribed to a set of settings, only return those changes.
			if (settings) params = changedSettings.filter(({ name }) =>
				settings.indexOf(name) > -1);

			if (params.length) {
				callback(params.reduce((momento, { name, value }) => {
					momento[name] = value;
					return momento;
				}, {}));
			}
		});
	}

	private dispose () {
		this.changeConfigurationHandler.dispose();
	}

	/**
	 * Gets settings changes for section
	 * Compares all new settings with previous settings (first-level only) within the specified
	 * section, and returns all changed settings in an array.
	 */
	private getSectionSettingChanges (): Setting[] {
		const newSettings = workspace.getConfiguration(this.section);
		const settingKeys = Object.keys(this.currentSettings);
		const changedSettings: Setting[] = [];

		settingKeys.forEach(key => {
			/*
			 * Comparing string representations of values. This handles objects too, but will only
			 * indicate that an object has changed, not what properties.
			 */
			const currentVal = JSON.stringify(this.currentSettings[key]);
			const newVal = JSON.stringify(newSettings[key]);

			if (newVal !== currentVal) {
				changedSettings.push({
					name: key,
					value: JSON.parse(newVal)
				} as Setting);
			}
		});

		this.currentSettings = newSettings;
		return changedSettings;
	}

}
