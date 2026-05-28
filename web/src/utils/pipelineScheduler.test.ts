import { describe, expect, it } from 'vitest';
import { PipelineScheduler } from '../../../tradex/pipeline/scheduler';

describe('PipelineScheduler', () => {
  it('stop waits for an in-flight scheduled task before resolving', async () => {
    const scheduler = new PipelineScheduler({} as never) as any;
    let release!: () => void;
    let completed = false;
    let stopSettled = false;

    const run = scheduler.runExclusive('pipeline', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      completed = true;
    });

    await Promise.resolve();

    const stop = scheduler.stop().then(() => {
      stopSettled = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(stopSettled).toBe(false);

    release();
    await run;
    await stop;

    expect(completed).toBe(true);
    expect(stopSettled).toBe(true);
  });

  it('reload waits for in-flight task and preserves started state', async () => {
    const scheduler = new PipelineScheduler({
      config: { pipeline: { enabled: false, instruments: [] }, evolution: { enabled: false } },
      pipelineOrchestrator: null,
    } as never) as any;
    let release!: () => void;
    let completed = false;

    scheduler.start();
    const run = scheduler.runExclusive('evolution:returns', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      completed = true;
    });

    await Promise.resolve();
    const reload = scheduler.reload();
    await Promise.resolve();
    expect(completed).toBe(false);

    release();
    await run;
    await reload;

    expect(completed).toBe(true);
    expect(scheduler.started).toBe(true);
  });
});
