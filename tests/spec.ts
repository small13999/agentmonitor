import { test, type TestContext } from "node:test";

/** Registers a test covering a SPEC.md claim; scripts/spec-check.ts reads these calls statically. */
export function spec(id: string, title: string, fn: (t: TestContext) => void | Promise<void>): void {
  test(`${id}: ${title}`, fn);
}
