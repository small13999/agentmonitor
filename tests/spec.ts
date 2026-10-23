import { test, type TestContext, type TestOptions } from "node:test";

/**
 * Registers a test covering a SPEC.md claim; scripts/spec-check.ts reads these calls statically.
 * `options.timeout` is for a test whose real stack takes longer than the suite's limit.
 */
export function spec(id: string, title: string, fn: (t: TestContext) => void | Promise<void>, options: Pick<TestOptions, "timeout"> = {}): void {
  test(`${id}: ${title}`, options, fn);
}
