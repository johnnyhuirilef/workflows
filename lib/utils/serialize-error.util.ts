import { inspect } from 'node:util';
import type { SerializedWorkflowError } from '../interfaces/serialized-workflow-error.interface.js';

/**
 * Never throws: a thrown value the engine can't serialize (a circular object, a
 * BigInt, `undefined`) is described by `util.inspect()` instead, so the instance
 * still records an outcome. The text has no U+0000 and no lone surrogate (each
 * becomes U+FFFD): an error is what the instance records, and a store that can't
 * keep its text would fail the write that records it, again at every lease.
 */
export function serializeError(error: unknown): SerializedWorkflowError {
  const { name, message, stack } = describe(error);
  return { name: clean(name), message: clean(message), ...(stack === undefined ? {} : { stack: clean(stack) }) };
}

function clean(text: string): string {
  return text.replaceAll('\u0000', '\uFFFD').toWellFormed();
}

function describe(error: unknown): SerializedWorkflowError {
  if (error instanceof Error) {
    // Strings, as the record promises: a name or stack that isn't one is described, not thrown on.
    return {
      name: text(error.name || 'Error'),
      message: text(error.message),
      ...(error.stack === undefined ? {} : { stack: text(error.stack) }),
    };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  let message: string | undefined;
  try {
    message = JSON.stringify(error);
  } catch {
    // circular, or a BigInt: described below
  }

  return { name: 'Error', message: message ?? inspect(error, { depth: 3, breakLength: Infinity }) };
}

/** `String(value)`, or `util.inspect()` for a value `String()` throws on (no prototype, a throwing `toString()`). */
function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return inspect(value, { depth: 3, breakLength: Infinity });
  }
}
