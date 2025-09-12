/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

import Log  from "./logger.js";

export type Callback = (...args: any[]) => void;

export const assertCallback: Callback = (...args) => {
  throw new Error('Callback function has not been implemented.');
}; 

export const noopCallback: Callback = (...args) => {
  Log.v('No operation callback invoked with arguments:', args);
};

export function initObjectWithFalsyValues<T extends object>(template: T): T {
  const result: any = {};

  for (const [key, value] of Object.entries(template)) {
    if (Array.isArray(value)) {
      result[key] = [];
    } else if (value !== null && typeof value === 'object') {
      result[key] = initObjectWithFalsyValues(value);
    } else if (typeof value === 'number') {
      result[key] = NaN;
    } else if (typeof value === 'string') {
      result[key] = '';
    } else if (typeof value === 'boolean') {
      result[key] = false;
    } else {
      result[key] = undefined;
    }
  }

  return result;
}