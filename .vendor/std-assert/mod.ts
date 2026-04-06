// Local shim for @std/assert (for offline dev)
export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) throw new Error(msg || "Assertion failed");
}

export function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertExists<T>(value: T, msg = ""): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(msg || `Expected value to exist, got ${value}`);
  }
}

export function assertNotEquals(actual: unknown, expected: unknown, msg = ""): void {
  if (Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)) {
    throw new Error(msg || `Expected values to be not equal: ${JSON.stringify(actual)}`);
  }
}

export function assertStringIncludes(actual: string, expected: string, msg = ""): void {
  if (!actual.includes(expected)) {
    throw new Error(msg || `Expected "${actual}" to include "${expected}"`);
  }
}

export function assertThrows(
  // deno-lint-ignore no-explicit-any
  fn: () => unknown,
  ErrorClass?: new (...args: any[]) => Error,
  msgIncludes?: string,
): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    if (ErrorClass && !(e instanceof ErrorClass)) {
      throw new Error(`Expected error to be instance of ${ErrorClass.name}, got ${e}`);
    }
    if (msgIncludes && !(e instanceof Error && e.message.includes(msgIncludes))) {
      throw new Error(`Expected error message to include "${msgIncludes}", got ${e}`);
    }
  }
  if (!threw) {
    throw new Error("Expected function to throw");
  }
}
