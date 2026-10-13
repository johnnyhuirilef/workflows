/**
 * Text PostgreSQL or MySQL can't store: U+0000 (PostgreSQL) and a lone UTF-16 surrogate (both). A value the caller
 * gives is refused with a TypeError that names where it sits, and a name the run makes up fails the run at the call that makes it, on every store:
 * reaching the store, either fails every write that carries it, and the instance is retried at every lease.
 */
import { Inject, Logger } from '@nestjs/common';
import { ManualWorkflowClock, Workflow, WorkflowSchedules, type WorkflowContext } from '../lib/index.js';
import { serializeError } from '../lib/utils/serialize-error.util.js';
import { findUnstorableText, unstorableText } from '../lib/utils/storable-text.util.js';
import { boot, tempDb, type Node, type TestDb, World } from './support.js';

const jsonParseError = (): SyntaxError => {
  try {
    JSON.parse('😀 not json');
  } catch (error) {
    return error as SyntaxError;
  }
  throw new Error('JSON.parse accepted the text');
};

describe('serializeError()', () => {
  it('replaces U+0000 and a lone surrogate in the name, message and stack of an error, and in a thrown value', () => {
    const error = Object.assign(new Error('a\u0000b x\ud83d'), { name: 'My\u0000Error' });
    error.stack = 'My\u0000Error: a\u0000b\n    at \udc00';
    expect(serializeError(error)).toEqual({
      name: 'My\uFFFDError',
      message: 'a\uFFFDb x\uFFFD',
      stack: 'My\uFFFDError: a\uFFFDb\n    at \uFFFD',
    });
    expect(serializeError('a\u0000b\ud83d').message).toBe('a\uFFFDb\uFFFD');
    expect(serializeError({ toJSON: () => 'x\u0000' }).message).toBe('"x\\u0000"');
    expect(serializeError(Symbol('s\u0000')).message).toBe('Symbol(s\uFFFD)');
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

  it('returns well-formed text for the lone surrogate in the message of a JSON.parse error (V8 names the first half of the emoji)', () => {
    const thrown = jsonParseError();
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(thrown.message.isWellFormed()).toBe(false);
    const { message, stack } = serializeError(thrown);
    expect(message.isWellFormed()).toBe(true);
    expect(message).toContain('Unexpected token');
    expect(stack!.isWellFormed()).toBe(true);
  });

  it('keeps the text of an error a database can store', () => {
    expect(serializeError(new Error('😀 ok \u0001'))).toMatchObject({ name: 'Error', message: '😀 ok \u0001' });
  });
});

describe('findUnstorableText()', () => {
  it('names the problem of a string', () => {
    expect(unstorableText('a\u0000b')).toBe('U+0000');
    expect(unstorableText('x\ud83d')).toBe('a lone UTF-16 surrogate');
    expect(unstorableText('\udc00x')).toBe('a lone UTF-16 surrogate');
    expect(unstorableText('😀 \u0001\t\n� \\u0000 \\ud83d')).toBeUndefined();
  });

  it('finds the first string it refuses, with its path, in a value or in an object key', () => {
    expect(findUnstorableText({ lines: [{ note: 'ok' }, { note: 'x\ud83d' }] })).toEqual({
      path: '$.lines[1].note',
      problem: 'a lone UTF-16 surrogate',
    });
    expect(findUnstorableText('a\u0000')).toEqual({ path: '$', problem: 'U+0000' });
    expect(findUnstorableText({ 'a\u0000': 1 })).toEqual({ path: '$["a\\u0000"] (its key)', problem: 'U+0000' });
    expect(findUnstorableText({ 'x-trace': ['ok', 1, null, true, { b: '😀' }] })).toBeUndefined();
  });

  it('finds text deeper than a recursive walk or JSON.parse() could go', () => {
    let deep: unknown = 'leaf\u0000';
    for (let i = 0; i < 100_000; i++) {
      deep = [deep];
    }
    expect(findUnstorableText(deep)).toEqual({ path: `$${'[0]'.repeat(100_000)}`, problem: 'U+0000' });
  });
});

/** What a database refuses, and why the error says so. */
const refused = [
  ['U+0000', 'a\u0000b', 'U+0000'],
  ['a lone surrogate', 'x\ud83d', 'a lone UTF-16 surrogate'],
] as const;

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

describe('text a database refuses, in what the caller gives', () => {
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

  describe.each(refused)('%s', (_name, text, problem) => {
    it('fails a step that returns it, once: the body ran once, and the run compensates', async () => {
      const ended = await run('result', text);
      expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'StepFailedError' } });
      expect(ended.error!.message).toContain(`NonRetryableStepError: Result of "save" at $.note holds ${problem}`);
      expect(world.ops()).toEqual(['reserve', 'save', 'undo reserve']);
    });

    it('fails a run whose output holds it, and the run compensates', async () => {
      const ended = await run('output', text);
      expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError' } });
      expect(ended.error!.message).toContain(`Workflow output at $.note holds ${problem}`);
      expect(world.ops()).toEqual(['reserve', 'undo reserve']);
    });

    it('fails a run whose child input holds it, before the child exists', async () => {
      const ended = await run('child', text);
      expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError' } });
      expect(ended.error!.message).toContain(`Input at $.note holds ${problem}`);
      expect(world.ops()).toEqual(['reserve', 'undo reserve']);
      expect(await node.client.list({ workflow: 'storable-leaf' })).toEqual([]);
    });

    it('fails a run whose status holds it, at ctx.setStatus()', async () => {
      const ended = await run('status', text);
      expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError' } });
      expect(ended.error!.message).toContain(`ctx.setStatus() value at $.note holds ${problem}`);
      expect(ended.customStatus).toBeNull();
    });

    it('refuses it as the progress of a step, to the step', async () => {
      const ended = await run('progress', text);
      expect(ended).toMatchObject({ status: 'completed', runs: 1, output: 'done' });
      expect(world.ops()).toEqual([
        'reserve',
        `TypeError: Step progress at $.note holds ${problem}, which a database can't store (U+0000 and lone UTF-16 surrogates are refused).`,
      ]);
    });

    it('refuses it in the input of start(), storing nothing', async () => {
      await expect(node.client.start(Storable, { at: 'x', note: text }, { id: 'in' })).rejects.toThrow(TypeError);
      await expect(node.client.start(Storable, { at: 'x', note: text }, { id: 'in' })).rejects.toThrow(`Input at $.note holds ${problem}`);
      expect(await node.client.getStatus('in')).toBeNull();
    });

    it('refuses it in the payload of a signal, and in the reason of a cancel', async () => {
      await expect(node.client.signal('paid', { note: text })).rejects.toThrow(`Signal payload at $.note holds ${problem}`);
      await node.client.start(Storable, { at: 'x' }, { id: 'c' });
      await expect(node.client.cancel('c', text)).rejects.toThrow(TypeError);
      await expect(node.client.terminate('c', text)).rejects.toThrow(`Reason holds ${problem}`);
    });

    it('refuses it in the input of a declared schedule, when the workflow is declared', () => {
      expect(() => Workflow('declared', { schedules: [{ id: 'nightly', every: '1h', input: { note: text } }] })).toThrow(
        `Schedule "nightly" of workflow "declared": its input at $.note holds ${problem}`,
      );
    });

    it('refuses it in the input of a schedule', async () => {
      await expect(
        node.moduleRef.get(WorkflowSchedules).upsert('nightly', { workflow: Storable, every: '1h', input: { at: 'x', note: text } }),
      ).rejects.toThrow(`Schedule "nightly": its input at $.note holds ${problem}`);
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

  describe.each(refused)('%s in a name the run makes up', (_name, text, problem) => {
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
      ['child', "A child's id"],
    ])('fails the run at the %s call, before it is journaled, and the run compensates', async (at, what) => {
      const ended = await names(at);
      expect(ended).toMatchObject({ status: 'failed', runs: 1, error: { name: 'TypeError' } });
      expect(ended.error!.message).toBe(
        `${what} holds ${problem}, which a database can't store (U+0000 and lone UTF-16 surrogates are refused).`,
      );
      expect(world.ops()).toEqual(['reserve', 'undo reserve']);
      expect(await node.client.list({ workflow: 'storable-leaf' })).toEqual([]);
    });

    it('refuses it in the id of start(), the name, key and id of signal()', async () => {
      await expect(node.client.start(Names, { at: 'step' }, { id: `i ${text}` })).rejects.toThrow(`An instance id holds ${problem}`);
      await expect(node.client.signal(`paid ${text}`, {})).rejects.toThrow(`A signal name holds ${problem}`);
      await expect(node.client.signal('paid', {}, { key: text })).rejects.toThrow(`A signal key holds ${problem}`);
      await expect(node.client.signal('paid', {}, { id: text })).rejects.toThrow(`A signal id holds ${problem}`);
      expect(await node.client.list({ workflow: 'names' })).toEqual([]);
    });
  });

  it.each(refused)('refuses %s in a concurrency key and in a rate-limit key, given or computed', async (_name, text, problem) => {
    await expect(node.client.start(Keyed, {}, { id: 'given', concurrencyKey: text })).rejects.toThrow(`A concurrency key holds ${problem}`);
    await expect(node.client.start(Keyed, {}, { id: 'rate', rateLimitKey: text })).rejects.toThrow(`A rate-limit key holds ${problem}`);
    note = text;
    await expect(node.client.start(Keyed, {}, { id: 'computed' })).rejects.toThrow(`A concurrency key holds ${problem}`);
    expect(await node.client.list({ workflow: 'keyed' })).toEqual([]);
  });

  it.each(refused)('records the error text of a step and of a run with %s replaced, and ends without a loop', async (_name, text) => {
    note = text;
    const replaced = `boom ${text.replace(/[\u0000\ud83d]/, '\uFFFD')}`;
    for (const at of ['throws', 'step-throws']) {
      await node.client.start(Thrower, { at }, { id: at });
    }
    await node.worker.drain();
    clock.advance('1h');
    await node.worker.drain();

    const run = (await node.client.getStatus('throws'))!;
    const step = (await node.client.getStatus('step-throws'))!;
    expect(run).toMatchObject({ status: 'failed', runs: 1, error: { name: 'Error', message: replaced } });
    expect(step).toMatchObject({ status: 'failed', runs: 1, error: { name: 'StepFailedError' } });
    expect(step.error!.message).toContain(`Error: ${replaced}`);
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
    expect(parsed.error!.message.isWellFormed()).toBe(true);
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

describe.each(refused)('%s in the input a declared schedule computes', (_name, text, problem) => {
  it('skips the occurrence, logged, and starts the next one that holds none', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const db = await tempDb();
    const clock = new ManualWorkflowClock();
    const world = new World();
    const node = await boot({ db, clock, workflows: [Noted], providers: [{ provide: World, useValue: world }] });
    try {
      note = text;
      clock.advance('1h');
      await node.worker.drain();
      expect(world.ops()).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`couldn't start its occurrence of`));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`Input at $.note holds ${problem}`));

      note = 'ok';
      clock.advance('1h');
      await node.worker.drain();
      expect(world.ops()).toEqual(['noted']);
    } finally {
      vi.restoreAllMocks();
      await node.close();
      db.cleanup();
    }
  });
});
