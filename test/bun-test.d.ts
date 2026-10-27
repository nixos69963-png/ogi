/// <reference types="node" />

/**
 * Minimal ambient types for `bun:test`.
 *
 * The CLI ships with no runtime dependencies and the typecheck must not need
 * one, so the five symbols the suite actually uses are declared here instead of
 * pulling in a types package. Bun runs the files; tsc only reads them.
 */
declare module "bun:test" {
  interface Matchers {
    toBe(value: unknown): void;
    toEqual(value: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toContain(value: unknown): void;
    toMatch(pattern: string | RegExp): void;
    toBeGreaterThan(value: number): void;
    toBeGreaterThanOrEqual(value: number): void;
    toBeLessThan(value: number): void;
    toBeLessThanOrEqual(value: number): void;
    toBeCloseTo(value: number, digits?: number): void;
    toBeInstanceOf(value: unknown): void;
    /** A string/RegExp matches the message; an error class matches the type thrown. */
    toThrow(message?: string | RegExp | (new (...args: never[]) => Error)): void;
    /** Awaits the promise and asserts on its fulfilment (or rejection). */
    resolves: Matchers;
    rejects: Matchers;
    not: Matchers;
  }

  interface Asymmetric {
    objectContaining(value: Record<string, unknown>): unknown;
    any(): unknown;
    anything(): unknown;
    arrayContaining(value: readonly unknown[]): unknown;
    stringContaining(value: string): unknown;
    stringMatching(pattern: string | RegExp): unknown;
  }

  export function describe(name: string, fn: () => void, timeout?: number): void;
  export const expect: ((value: unknown, message?: string) => Matchers) & Asymmetric;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  interface ItApi {
    (name: string, fn: () => void | Promise<void>, timeout?: number): void;
    skipIf(condition: boolean): (name: string, fn: () => void | Promise<void>) => void;
  }
  export const it: ItApi;
}
