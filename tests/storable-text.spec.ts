/**
 * Text a store can't keep (`WorkflowStore.unstorableText()`): PostgreSQL keeps U+0000 in neither `text` nor `jsonb`,
 * and neither PostgreSQL nor MySQL keeps a lone UTF-16 surrogate in JSON. Reaching the store, such text fails every
 * write that carries it, and the instance is retried at every lease; so the engine refuses it with a TypeError that
 * names where it sits, at the call that gives it, and a run fails and compensates. What a store keeps is kept as
 * before: the in-memory store keeps both, MySQL keeps U+0000, an id or a key in a text column of its own keeps a lone
 * surrogate as the SQL stores do (as U+FFFD), and what a codec encodes reaches the store encoded.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Logger } from '@nestjs/common';
import { AesGcmPayloadCodec, ManualWorkflowClock, Workflow, WorkflowSchedules, type WorkflowContext } from '../lib/index.js';
import { serializeError } from '../lib/utils/serialize-error.util.js';
import { findUnstorableText, loneSurrogateIn, nulIn, storableText, type TextCheck } from '../lib/utils/storable-text.util.js';
import { boot, storeKind, tempDb, type Node, type TestDb, World } from './support.js';

const jsonParseError = (): SyntaxError => {
  try {
    JSON.parse('😀 not json');
  } catch (error) {
    return error as SyntaxError;
  }
  throw new Error('JSON.parse accepted the text');
};

/** PostgreSQL's check of JSON, for the util's own tests. */
const both: TextCheck = (text) => nulIn(text) ?? loneSurrogateIn(text);

describe('serializeError()', () => {
  it("keeps an error's text as it is: what a store can't keep of it is replaced as it is written", () => {
    const error = Object.assign(new Error('a\u0000b x\ud83d'), { name: 'My\u0000Error' });
    error.stack = 'My\u0000Error: a\u0000b\n    at \udc00';
    expect(serializeError(error)).toEqual({ name: 'My\u0000Error', message: 'a\u0000b x\ud83d', stack: 'My\u0000Error: a\u0000b\n    at \udc00' });
    expect(serializeError('a\u0000b\ud83d').message).toBe('a\u0000b\ud83d');
  });

  it('describes an error whose name or stack is not a string, as strings of the record', () => {
    const odd = Object.assign(new Error('x'), { name: 42 as unknown as string });
    odd.stack = 123 as unknown as string;
    expect(serializeError(odd)).toEqual({ name: '42', message: 'x', stack: '123' });
    const bare = Object.assign(new Error('y'), { stack: undefined });
    expect(serializeError(bare)).toEqual({ name: 'Error', message: 'y' });
    const unprintable = Object.assign(new Error('z'), { name: Object.create(null) as string });
    expect(serializeError(unprintable)).toMatchObject({ name: '[Object: null prototype] {}', message: 'z' });
  });
});

describe('findUnstorableText()', () => {
  it('names the problem of a string', () => {
    expect(nulIn('a\u0000b')).toBe('U+0000');
    expect(loneSurrogateIn('x\ud83d')).toBe('a lone UTF-16 surrogate');
    expect(loneSurrogateIn('\udc00x')).toBe('a lone UTF-16 surrogate');
    expect(both('😀 \u0001\t\n� \\u0000 \\ud83d')).toBeUndefined();
  });

  it('finds the first string it refuses, with its path, in a value or in an object key', () => {
    expect(findUnstorableText({ lines: [{ note: 'ok' }, { note: 'x\ud83d' }] }, both)).toEqual({
      path: '$.lines[1].note',
      problem: 'a lone UTF-16 surrogate',
    });
    expect(findUnstorableText('a\u0000', both)).toEqual({ path: '$', problem: 'U+0000' });
    expect(findUnstorableText({ 'a\u0000': 1 }, both)).toEqual({ path: '$["a\\u0000"] (its key)', problem: 'U+0000' });
    expect(findUnstorableText({ 'x-trace': ['ok', 1, null, true, { b: '😀' }] }, both)).toBeUndefined();
  });

  it('finds them in the order of the JSON: a nested string before a later one, a key before its value', () => {
    expect(findUnstorableText({ a: { b: 'x\u0000' }, c: 'y\u0000' }, both)?.path).toBe('$.a.b');
    expect(findUnstorableText([1, true, null, { 'k\u0000': 'v\u0000' }], both)).toEqual({ path: '$[3]["k\\u0000"] (its key)', problem: 'U+0000' });
    expect(findUnstorableText({ a: 1, 'b\u0000': false }, both)?.path).toBe('$["b\\u0000"] (its key)');
  });

  it('finds text deeper than a recursive walk or JSON.parse() could go', () => {
    let deep: unknown = 'leaf\u0000';
    for (let i = 0; i < 100_000; i++) {
      deep = [deep];
    }
    expect(findUnstorableText(deep, both)).toEqual({ path: `$${'[0]'.repeat(100_000)}`, problem: 'U+0000' });
  });

  it("replaces what the check refuses in an error's text, and keeps the rest", () => {
    expect(storableText('a\u0000b\ud83d 😀', both)).toBe('a�b� 😀');
    expect(storableText('ok 😀 \u0001', both)).toBe('ok 😀 \u0001');
    expect(storableText('a\u0000b', undefined)).toBe('a\u0000b');
  });
});

const postgres = storeKind === 'pglite' || storeKind === 'postgres';

/** Whether this run's store refuses `kind` in a JSON value, or in a text column of its own. */
const refuses = (kind: 'nul' | 'surrogate', column: 'json' | 'text'): boolean => (kind === 'nul' ? postgres : storeKind !== 'memory' && column === 'json');

/** Text a store may refuse, why the error says it does, and which kind it is. */
const cases = [
  ['U+0000', 'a\u0000b', 'U+0000', 'nul'],
  ['a lone surrogate', 'x\ud83d', 'a lone UTF-16 surrogate', 'surrogate'],
] as const;

const refusal = (where: string, problem: string) => `${where} holds ${problem}, which the workflow store can't keep.`;

@Workflow('storable-leaf')
class Leaf {
  constructor(@Inject(World) private readonly world: World) {}

  run(_ctx: WorkflowContext, _input: unknown) {
    this.world.record('leaf', 'leaf');
  }
}

/** The text the workflows hold in what they make: not their input, which is refused when it starts. */
let note = '';

/** Does what `input.at` says with `note`, after a step that has a compensation. */
@Workflow('storable')
class Storable {
  constructor(@Inject(World) private readonly world: World) {}

  async run(ctx: WorkflowContext, input: { at: string; note?: string; text?: string }) {
    await ctx.step('reserve', () => this.world.record('reserve', 'r'), { compensate: () => this.world.record('undo reserve', 'r') });
    switch (input.at) {
      case 'result':
        await ctx.step('save', () => (this.world.record('save', 's'), { note }), { retry: 5 });
        return 'done';
      case 'output':
        return { note };
      case 'child':
        await ctx.executeChild(Leaf, { note });
        return 'done';
      case 'status':
        ctx.setStatus({ note });
        return 'done';
      case 'progress':
        return ctx.step('save', async (s) => {
          try {
            await s.heartbeat({ note });
          } catch (error) {
            this.world.record(`${(error as Error).name}: ${(error as Error).message}`, 'progress');
          }
          return 'done';
        });
      default:
        return { note };
    }
  }
}

/** Makes up a name from `note` at `input.at`, after a step that has a compensation. */
@Workflow('names')
class Names {
  constructor(@Inject(World) private readonly world: World) {}

  async run(ctx: WorkflowContext, input: { at: string }) {
    await ctx.step('reserve', () => this.world.record('reserve', 'r'), { compensate: () => this.world.record('undo reserve', 'r') });
    switch (input.at) {
      case 'step':
        return ctx.step(`step ${note}`, () => this.world.record('ran', 'step'));
      case 'sleep':
        return ctx.sleep(`sleep ${note}`, '1h');
      case 'wait':
        return ctx.waitForSignal(`wait ${note}`, 'paid');
      case 'signal':
        return ctx.waitForSignal('wait', `paid ${note}`);
      case 'key':
        return ctx.waitForSignal('wait', 'paid', { key: note });
      case 'any':
        return ctx.waitForAny('any', { paid: ctx.signalWait('paid', { key: note }) });
      case 'branch':
        return ctx.waitForAny('any', { [`paid ${note}`]: ctx.signalWait('paid') });
      default:
        return ctx.executeChild(Leaf, {}, { id: `child ${note}` });
    }
  }
}

/** Counts per key: a key start() is given, and one the workflow computes (from `note`, for the test). */
@Workflow('keyed', { concurrency: { limit: 5, key: () => note || null }, rateLimit: { max: 5, duration: '1m', key: () => null } })
class Keyed {
  run(_ctx: WorkflowContext, _input: unknown) {}
}

/** Throws an error whose text is `boom ${note}`, from run() or from a step. */
@Workflow('thrower')
class Thrower {
  constructor(@Inject(World) private readonly world: World) {}

  async run(ctx: WorkflowContext, input: { at: string }) {
    if (input.at === 'throws') {
      throw new Error(`boom ${note}`);
    }
    if (input.at === 'odd-name') {
      throw Object.assign(new Error('odd'), { name: 42 as unknown as string });
    }
    if (input.at === 'json-parse') {
      throw jsonParseError();
    }
    await ctx.step(
      'fail',
      () => {
        this.world.record('thrown', 't');
        throw new Error(`boom ${note}`);
      },
      { retry: 1 },
    );
  }
}

/** A declared schedule whose input function returns `note`. */
@Workflow('noted', { schedules: [{ id: 'noted', every: '1h', input: () => ({ note }) }] })
class Noted {
  constructor(@Inject(World) private readonly world: World) {}

  run(_ctx: WorkflowContext, _input: unknown) {
    this.world.record('noted', 'n');
  }
}

describe('text a store may refuse, in what the caller gives and the run makes', () => {
  let db: TestDb;
  let clock: ManualWorkflowClock;
  let world: World;
  let node: Node;

  beforeEach(async () => {
    note = '';
    db = await tempDb();
    clock = new ManualWorkflowClock();
    world = new World();
    node = await boot({ db, clock, workflows: [Storable, Names, Keyed, Thrower, Leaf], providers: [{ provide: World, useValue: world }] });
  });

  afterEach(async () => {
    await node.close();
    db.cleanup();
  });

  /** Starts the workflow, then lets a lease pass: a run that would be retried at every lease shows in `runs`. */
  const run = async (at: string, text: string) => {
    note = text;
    await node.client.start(Storable, { at }, { id: at });
    await node.worker.drain();
    clock.advance('1h');
    await node.worker.drain();
    return (await node.client.getStatus(at))!;
  };

  describe.each(cases)('%s', (_name, text, problem, kind) => {
    const json = refuses(kind, 'json');
    const column = refuses(kind, 'text');

    it(`${json ? 'fails' : 'keeps'} a step result that holds it`, async () => {
      const ended = await run('result', text);
      if (json) {
        // Once: the body ran once, and the run compensates.
        expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'StepFailedError' } });
        expect(ended.error!.message).toContain(`NonRetryableStepError: ${refusal('Result of "save" at $.note', problem)}`);
        expect(world.ops()).toEqual(['reserve', 'save', 'undo reserve']);
      } else {
        expect(ended).toMatchObject({ status: 'completed', runs: 1, output: 'done' });
        expect(world.ops()).toEqual(['reserve', 'save']);
      }
    });

    it(`${json ? 'fails' : 'keeps'} a run's output that holds it`, async () => {
      const ended = await run('output', text);
      if (json) {
        expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError', message: refusal('Workflow output at $.note', problem) } });
        expect(world.ops()).toEqual(['reserve', 'undo reserve']);
      } else {
        expect(ended).toMatchObject({ status: 'completed', runs: 1, output: { note: text } });
      }
    });

    it(`${json ? 'fails a run at' : 'starts'} a child whose input holds it`, async () => {
      const ended = await run('child', text);
      if (json) {
        expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError', message: refusal('Input at $.note', problem) } });
        expect(world.ops()).toEqual(['reserve', 'undo reserve']);
        expect(await node.client.list({ workflow: 'storable-leaf' })).toEqual([]);
      } else {
        expect(ended).toMatchObject({ status: 'completed', output: 'done' });
        expect(world.count('leaf')).toBe(1);
      }
    });

    it(`${json ? 'fails a run at' : 'keeps'} a status that holds it (ctx.setStatus())`, async () => {
      const ended = await run('status', text);
      if (json) {
        expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError', message: refusal('ctx.setStatus() value at $.note', problem) } });
        expect(ended.customStatus).toBeNull();
      } else {
        expect(ended).toMatchObject({ status: 'completed', runs: 1, customStatus: { note: text } });
      }
    });

    it(`${json ? 'refuses' : 'keeps'} it as the progress of a step${json ? ', to the step' : ''}`, async () => {
      const ended = await run('progress', text);
      expect(ended).toMatchObject({ status: 'completed', runs: 1, output: 'done' });
      expect(world.ops()).toEqual(json ? ['reserve', `TypeError: ${refusal('Step progress at $.note', problem)}`] : ['reserve']);
    });

    it(`${json ? 'refuses' : 'keeps'} it in the input of start()`, async () => {
      const start = () => node.client.start(Storable, { at: 'x', note: text }, { id: 'in' });
      if (json) {
        await expect(start()).rejects.toThrow(TypeError);
        await expect(start()).rejects.toThrow(refusal('Input at $.note', problem));
        expect(await node.client.getStatus('in')).toBeNull();
      } else {
        await start();
        expect(await node.client.getStatus('in')).toMatchObject({ input: { at: 'x', note: text } });
      }
    });

    it(`${json ? 'refuses' : 'takes'} it in the payload of a signal, and ${column ? 'refuses' : 'takes'} it in the reason of a cancel`, async () => {
      const signal = () => node.client.signal('paid', { note: text });
      if (json) {
        await expect(signal()).rejects.toThrow(refusal('Signal payload at $.note', problem));
      } else {
        await expect(signal()).resolves.toMatchObject({ created: true });
      }

      await node.client.start(Storable, { at: 'x' }, { id: 'c' });
      await node.client.start(Storable, { at: 'x' }, { id: 't' });
      const cancel = () => node.client.cancel('c', text);
      const terminate = () => node.client.terminate('t', text);
      if (column) {
        await expect(cancel()).rejects.toThrow(TypeError);
        await expect(terminate()).rejects.toThrow(refusal('Reason', problem));
      } else {
        await expect(cancel()).resolves.toBeDefined();
        await expect(terminate()).resolves.toBeDefined();
      }
    });

    it('takes it in the input of a declared schedule when the workflow is declared: the store is checked at startup', () => {
      expect(() => Workflow('declared', { schedules: [{ id: 'nightly', every: '1h', input: { note: text } }] })).not.toThrow();
    });

    it(`${json ? 'refuses' : 'keeps'} it in the input of a schedule`, async () => {
      const upsert = () => node.moduleRef.get(WorkflowSchedules).upsert('nightly', { workflow: Storable, every: '1h', input: { at: 'x', note: text } });
      if (json) {
        await expect(upsert()).rejects.toThrow(refusal('Schedule "nightly": its input at $.note', problem));
      } else {
        await expect(upsert()).resolves.toMatchObject({ input: { at: 'x', note: text } });
      }
    });
  });

  it('keeps surrogate pairs and ordinary text, in a result, an output and an input', async () => {
    const text = 'ok 😀 \u0001\t\n\\u0000 \\ud83d �';
    const ended = await run('result', text);
    expect(ended).toMatchObject({ status: 'completed', runs: 1, output: 'done' });
    expect(world.ops()).toEqual(['reserve', 'save']);
    expect(await run('output', text)).toMatchObject({ status: 'completed', output: { note: text } });
    await node.client.start(Storable, { at: 'x', text }, { id: 'in' });
    expect(await node.client.getStatus('in')).toMatchObject({ input: { at: 'x', text } });
  });

  describe.each(cases)('%s in a name the run makes up', (_name, text, problem, kind) => {
    // A journal entry's JSON holds its name, a child's id ($child:<id>), a wait's signal and key, waitForAny()'s branches.
    const json = refuses(kind, 'json');
    const column = refuses(kind, 'text');

    const names = async (at: string) => {
      note = text;
      await node.client.start(Names, { at }, { id: at });
      await node.worker.drain();
      clock.advance('1h');
      await node.worker.drain();
      return (await node.client.getStatus(at))!;
    };

    it.each([
      ['step', "A journal entry's name (a step's, a sleep's or a wait's)"],
      ['sleep', "A journal entry's name (a step's, a sleep's or a wait's)"],
      ['wait', "A journal entry's name (a step's, a sleep's or a wait's)"],
      ['signal', "A wait's signal name"],
      ['key', "A wait's signal key"],
      ['any', "A wait's signal key"],
      ['branch', `A waitForAny("any") branch's name`],
      ['child', "A child's id"],
    ])(`${json ? 'fails the run at' : 'takes it in'} the %s call${json ? ', before it is journaled, and the run compensates' : ''}`, async (at, what) => {
      const ended = await names(at);
      if (json) {
        expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError', message: refusal(what, problem) } });
        expect(world.ops()).toEqual(['reserve', 'undo reserve']);
        expect(await node.client.list({ workflow: 'storable-leaf' })).toEqual([]);
      } else {
        expect(ended.status).not.toBe('failed');
        expect(world.ops()).not.toContain('undo reserve');
      }
    });

    it(`${column ? 'refuses' : 'takes'} it in the id of start(), the name, key and id of signal()`, async () => {
      const calls = [
        [() => node.client.start(Names, { at: 'step' }, { id: `i ${text}` }), 'An instance id'],
        [() => node.client.signal(`paid ${text}`, {}), 'A signal name'],
        [() => node.client.signal('paid', {}, { key: text }), 'A signal key'],
        [() => node.client.signal('paid', {}, { id: text }), 'A signal id'],
      ] as const;
      for (const [call, what] of calls) {
        if (column) {
          await expect(call()).rejects.toThrow(refusal(what, problem));
        } else {
          await expect(call()).resolves.toBeDefined();
        }
      }
      if (column) {
        expect(await node.client.list({ workflow: 'names' })).toEqual([]);
      }
    });
  });

  it.each(cases)('%s in a concurrency key and in a rate-limit key, given or computed', async (_name, text, problem, kind) => {
    const column = refuses(kind, 'text');
    const calls = [
      [() => node.client.start(Keyed, {}, { id: 'given', concurrencyKey: text }), 'A concurrency key'],
      [() => node.client.start(Keyed, {}, { id: 'rate', rateLimitKey: text }), 'A rate-limit key'],
      [() => ((note = text), node.client.start(Keyed, {}, { id: 'computed' })), 'A concurrency key'],
    ] as const;
    for (const [call, what] of calls) {
      if (column) {
        await expect(call()).rejects.toThrow(refusal(what, problem));
      } else {
        await expect(call()).resolves.toMatchObject({ created: true });
      }
    }
    expect(await node.client.list({ workflow: 'keyed' })).toHaveLength(column ? 0 : 3);
  });

  it.each(cases)("records the error text of a step and of a run with %s, replaced where the store can't keep it, and ends without a loop", async (_name, text, _problem, kind) => {
    note = text;
    const recorded = `boom ${refuses(kind, 'json') ? text.replace(/[\u0000\ud83d]/, '�') : text}`;
    for (const at of ['throws', 'step-throws']) {
      await node.client.start(Thrower, { at }, { id: at });
    }
    await node.worker.drain();
    clock.advance('1h');
    await node.worker.drain();

    const run = (await node.client.getStatus('throws'))!;
    const step = (await node.client.getStatus('step-throws'))!;
    expect(run).toMatchObject({ status: 'failed', runs: 1, error: { name: 'Error', message: recorded } });
    expect(step).toMatchObject({ status: 'failed', runs: 1, error: { name: 'StepFailedError' } });
    expect(step.error!.message).toContain(`Error: ${recorded}`);
    expect(world.count('thrown')).toBe(1);
  });

  it('ends a run whose error has a name that is not a string, and one that holds the lone surrogate V8 puts in a message', async () => {
    for (const at of ['odd-name', 'json-parse']) {
      await node.client.start(Thrower, { at }, { id: at });
    }
    await node.worker.drain();
    clock.advance('1h');
    await node.worker.drain();

    expect(await node.client.getStatus('odd-name')).toMatchObject({ status: 'failed', runs: 1, error: { name: '42', message: 'odd' } });
    const parsed = (await node.client.getStatus('json-parse'))!;
    expect(parsed).toMatchObject({ status: 'failed', runs: 1, error: { name: 'SyntaxError' } });
    expect(parsed.error!.message).toContain('Unexpected token');
    // Kept as it is where the store can keep it.
    expect(parsed.error!.message.isWellFormed()).toBe(refuses('surrogate', 'json'));
  });

  it('keeps a surrogate pair in a name, an id and a key', async () => {
    note = '😀';
    await node.client.start(Names, { at: 'key' }, { id: 'ok 😀' });
    await node.worker.drain();
    expect(await node.client.signal('paid', 'x', { key: '😀', id: 'id 😀' })).toMatchObject({ woken: 1 });
    await node.worker.drain();
    expect(await node.client.getStatus('ok 😀')).toMatchObject({ status: 'completed', output: 'x' });
  });
});

describe.each(cases)('%s in the input a declared schedule computes', (_name, text, problem, kind) => {
  const json = refuses(kind, 'json');

  it(json ? 'skips the occurrence, logged, and starts the next one that holds none' : 'starts the occurrence', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const db = await tempDb();
    const clock = new ManualWorkflowClock();
    const world = new World();
    const node = await boot({ db, clock, workflows: [Noted], providers: [{ provide: World, useValue: world }] });
    try {
      note = text;
      clock.advance('1h');
      await node.worker.drain();
      if (json) {
        expect(world.ops()).toEqual([]);
        expect(error).toHaveBeenCalledWith(expect.stringContaining(`couldn't start its occurrence of`));
        expect(error).toHaveBeenCalledWith(expect.stringContaining(refusal('Input at $.note', problem)));
      } else {
        expect(world.ops()).toEqual(['noted']);
      }

      note = 'ok';
      clock.advance('1h');
      await node.worker.drain();
      expect(world.ops()).toEqual(json ? ['noted'] : ['noted', 'noted']);
    } finally {
      vi.restoreAllMocks();
      await node.close();
      db.cleanup();
    }
  });
});

describe.each(cases)('%s in the input a schedule declares', (_name, text, problem, kind) => {
  const json = refuses(kind, 'json');

  it(json ? "leaves the schedule out at startup, logged, and saves the others" : 'saves the schedule at startup', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    @Workflow('declares', {
      schedules: [
        { id: 'declared', every: '1h', input: { note: text } },
        { id: 'other', every: '1h', input: { note: 'ok' } },
      ],
    })
    class Declares {
      run(_ctx: WorkflowContext, _input: unknown) {}
    }

    const db = await tempDb();
    const node = await boot({ db, clock: new ManualWorkflowClock(), workflows: [Declares] });
    try {
      const schedules = node.moduleRef.get(WorkflowSchedules);
      expect(await schedules.get('other')).toMatchObject({ input: { note: 'ok' } });
      if (json) {
        expect(await schedules.get('declared')).toBeNull();
        expect(error).toHaveBeenCalledWith(expect.stringContaining(refusal('Schedule "declared": its input at $.note', problem)));
      } else {
        expect(await schedules.get('declared')).toMatchObject({ input: { note: text } });
      }
    } finally {
      vi.restoreAllMocks();
      await node.close();
      db.cleanup();
    }
  });
});

describe('text a store may refuse, with a codec', () => {
  let db: TestDb;
  let clock: ManualWorkflowClock;
  let node: Node;

  beforeEach(async () => {
    note = '';
    db = await tempDb();
    clock = new ManualWorkflowClock();
    const codec = new AesGcmPayloadCodec({ keys: { k1: randomBytes(32) }, current: 'k1' });
    node = await boot({ db, clock, workflows: [Storable, Names, Leaf], providers: [{ provide: World, useValue: new World() }], codec });
  });

  afterEach(async () => {
    await node.close();
    db.cleanup();
  });

  const drained = async () => {
    await node.worker.drain();
    clock.advance('1h');
    await node.worker.drain();
  };

  it('keeps it in what the codec encodes, which the store sees encoded: inputs, results, outputs, payloads, reasons', async () => {
    const text = 'a\u0000b x\ud83d';
    note = text;
    await node.client.start(Storable, { at: 'result', note: text }, { id: 'result' });
    await node.client.start(Storable, { at: 'output' }, { id: 'output' });
    await expect(node.client.signal('paid', { note: text })).resolves.toMatchObject({ created: true });
    await node.client.start(Storable, { at: 'x' }, { id: 'c' });
    await expect(node.client.cancel('c', text)).resolves.toBeDefined();
    await drained();

    expect(await node.client.getStatus('result')).toMatchObject({ status: 'completed', runs: 1, input: { at: 'result', note: text } });
    expect(await node.client.getStatus('output')).toMatchObject({ status: 'completed', runs: 1, output: { note: text } });
  });

  it("refuses it in a name the run makes up where the store can't keep it: the codec doesn't encode names", async () => {
    note = 'x\ud83d';
    await node.client.start(Names, { at: 'step' }, { id: 'step' });
    await drained();

    const ended = (await node.client.getStatus('step'))!;
    if (refuses('surrogate', 'json')) {
      expect(ended).toMatchObject({
        status: 'failed',
        runs: 1,
        error: { name: 'TypeError', message: refusal("A journal entry's name (a step's, a sleep's or a wait's)", 'a lone UTF-16 surrogate') },
      });
    } else {
      expect(ended).toMatchObject({ status: 'completed', runs: 1 });
    }
  });
});
