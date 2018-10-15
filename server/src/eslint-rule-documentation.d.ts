/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
declare module "eslint-rule-documentation" {
	export default function ruleURI(ruleId: string): { found: boolean, url: string };
}
