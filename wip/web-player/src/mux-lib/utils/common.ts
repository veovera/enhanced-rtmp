/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (C) 2025 Veovera Software Organization
 * @author Slavik Lozben
 * 
 */

export type Callback = (...args: any[]) => void;

export const assertCallback = (...args: unknown[]): never => {
  throw new Error('Callback not implemented');
}; 