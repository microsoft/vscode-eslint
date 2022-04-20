/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

const toString = Object.prototype.toString;

export function boolean(value: any): value is boolean {
	return value === true || value === false;
}

export function nullOrUndefined(value: any): value is null | undefined {
	return value === null || value === undefined;
}

export function string(value: any): value is string {
	return toString.call(value) === '[object String]';
}