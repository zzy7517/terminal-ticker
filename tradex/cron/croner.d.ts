/**
 * Minimal type declarations for the `croner` package.
 * Remove this file once `npm install croner` is run and real types are available.
 */
declare module "croner" {
  interface CronOptions {
    timezone?: string;
    startAt?: string | Date;
    stopAt?: string | Date;
    maxRuns?: number;
    paused?: boolean;
    context?: unknown;
    name?: string;
    catch?: boolean | ((e: unknown) => void);
    protect?: boolean;
  }

  class Cron {
    constructor(pattern: string, callback?: () => void | Promise<void>);
    constructor(pattern: string, options: CronOptions, callback?: () => void | Promise<void>);

    /** Returns the next scheduled run as a Date, or null if no future run. */
    nextRun(): Date | null;

    /** Returns an array of upcoming run dates. */
    nextRuns(count: number): Date[];

    /** Stops the scheduled job. */
    stop(): void;

    /** Pauses the scheduled job. */
    pause(): void;

    /** Resumes a paused job. */
    resume(): void;

    /** Returns true if the job is running (callback in progress). */
    isBusy(): boolean;

    /** Returns true if the job is stopped. */
    isStopped(): boolean;
  }

  export { Cron, CronOptions };
}
