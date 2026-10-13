/**
 * Where the engine stores a piece of text, which decides what it asks the store (`WorkflowStore.unstorableText()`):
 * - `payload`: an input, a result, a payload, a status, an output, in a JSON column, which a codec encodes;
 * - `cancelReason`: a cancel's reason, in a text column, which a codec encodes;
 * - `name`: a journal entry's name (a step's, a wait's, `$child:<id>`), which the entry's JSON holds too, never encoded;
 * - `key`: an id, a name or a key in a text column of its own, never encoded.
 */
export type TextPlace = 'payload' | 'cancelReason' | 'name' | 'key';

/** What the store can't keep of `text` at a place (such as `'U+0000'`), or `undefined`. */
export type TextCheck = (text: string) => string | undefined;

/** A place's check, or `undefined` where the store keeps any text (`EncodedWorkflowStore.textCheck()`). */
export type TextChecks = (place: TextPlace) => TextCheck | undefined;

/** `'U+0000'` when `text` holds it (PostgreSQL keeps it in neither `text` nor `jsonb`), else `undefined`. */
export function nulIn(text: string): string | undefined {
  return text.includes('\u0000') ? 'U+0000' : undefined;
}

/** `'a lone UTF-16 surrogate'` when `text` holds one (PostgreSQL and MySQL refuse it in JSON), else `undefined`. */
export function loneSurrogateIn(text: string): string | undefined {
  return text.isWellFormed() ? undefined : 'a lone UTF-16 surrogate';
}

interface Step {
  readonly value: unknown;
  readonly parent: Step | undefined;
  /** Its index in an array, or its key in an object; `undefined` for the root. */
  readonly at: number | string | undefined;
  /** What `check` refuses in its key, reported before what its value holds. */
  readonly keyProblem?: string;
}

/**
 * The first string of a JSON value (what `JSON.parse()` returns), a value or an object's key, that `check` refuses,
 * with its path (`$.lines[0].note`), or `undefined`. Walks with a stack of its own, so a value as deep as
 * `JSON.stringify()` takes can't overflow the call stack; the path is built only for what it finds.
 */
export function findUnstorableText(value: unknown, check: TextCheck): { path: string; problem: string } | undefined {
  const pending: Step[] = [{ value, parent: undefined, at: undefined }];
  for (let step = pending.pop(); step; step = pending.pop()) {
    if (step.keyProblem) {
      return { path: `${pathOf(step)} (its key)`, problem: step.keyProblem };
    }

    const current = step.value;
    if (typeof current === 'string') {
      const problem = check(current);
      if (problem) {
        return { path: pathOf(step), problem };
      }
    } else if (Array.isArray(current)) {
      // Last first, so the first is checked first. Numbers, booleans and null hold no text.
      for (let i = current.length - 1; i >= 0; i--) {
        if (holdsText(current[i])) {
          pending.push({ value: current[i], parent: step, at: i });
        }
      }
    } else if (current !== null && typeof current === 'object') {
      const keys = Object.keys(current);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!;
        const child = (current as Record<string, unknown>)[key];
        const keyProblem = check(key);
        if (keyProblem || holdsText(child)) {
          pending.push({ value: child, parent: step, at: key, keyProblem });
        }
      }
    }
  }
  return undefined;
}

/** Throws a `TypeError` that names `what` when `check` refuses `text`. */
export function assertStorableText(what: string, text: string | null | undefined, check: TextCheck | undefined): void {
  const problem = check && typeof text === 'string' ? check(text) : undefined;
  if (problem) {
    throw unstorable(what, problem);
  }
}

/** The same for a JSON value (what `normalize()` returns), naming where in `what` the text sits. */
export function assertStorableJson(what: string, value: unknown, check: TextCheck | undefined): void {
  const refused = unstorableJson(what, value, check);
  if (refused) {
    throw refused;
  }
}

/** `assertStorableJson()`'s error, for a caller that reports it in its own way, or `undefined`. */
export function unstorableJson(what: string, value: unknown, check: TextCheck | undefined): TypeError | undefined {
  const found = check && findUnstorableText(value, check);
  return found ? unstorable(`${what} at ${found.path}`, found.problem) : undefined;
}

/**
 * `text`, with U+0000 and lone surrogates replaced with U+FFFD when `check` refuses it: for an error's text, which is
 * recorded whatever it holds.
 */
export function storableText(text: string, check: TextCheck | undefined): string {
  return check?.(text) === undefined ? text : text.replaceAll('\u0000', '�').toWellFormed();
}

function unstorable(where: string, problem: string): TypeError {
  return new TypeError(`${where} holds ${problem}, which the workflow store can't keep.`);
}

function holdsText(value: unknown): boolean {
  return typeof value === 'string' || (value !== null && typeof value === 'object');
}

function pathOf(step: Step): string {
  let path = '';
  for (let at: Step | undefined = step; at; at = at.parent) {
    path = segment(at.at) + path;
  }
  return path;
}

function segment(at: number | string | undefined): string {
  if (at === undefined) {
    return '$';
  }
  if (typeof at === 'number') {
    return `[${at}]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(at) ? `.${at}` : `[${JSON.stringify(at)}]`;
}
