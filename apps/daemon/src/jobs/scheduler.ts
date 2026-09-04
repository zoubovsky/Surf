import { Cron } from "croner";
import type { Logger } from "@surf/core";
import { floorToInterval } from "@surf/core";
import type { JobRunner } from "./runner.js";

export interface ScheduleOptions {
  runner: JobRunner;
  log: Logger;
  tz: string;
  /** "HH:MM" local time in tz for the daily brief. */
  dailyBriefTime: string;
  now?: () => number;
}

/** Cycle id for the hourly loop: the candle that just closed, in UTC. */
export function hourlyCycleId(now: number): string {
  const closed = floorToInterval(now, 3_600_000) - 3_600_000;
  return `hourly-${new Date(closed).toISOString().slice(0, 13)}Z`;
}

/**
 * Registers cron schedules that enqueue singleton jobs. All job execution happens in the runner,
 * so a slow cycle never overlaps with itself and restarts never double-run a candle.
 */
export function startSchedules(opts: ScheduleOptions): { stop: () => void } {
  const { runner, tz } = opts;
  const log = opts.log.child({ component: "scheduler" });
  const now = opts.now ?? (() => Date.now());
  const [bh, bm] = opts.dailyBriefTime.split(":").map(Number) as [number, number];
  const crons: Cron[] = [
    // Hourly decision loop, one minute after the candle close, UTC.
    new Cron("1 * * * *", { timezone: "UTC" }, () => {
      const id = hourlyCycleId(now());
      const enq = runner.enqueue("hourly-cycle", {
        singletonKey: id,
        payload: { cycleId: id },
        maxAttempts: 2,
      });
      log.info({ cycle: id, enqueued: enq !== null }, "hourly cycle scheduled");
    }),
    // Video feed poll every 5 minutes.
    new Cron("*/5 * * * *", { timezone: "UTC" }, () => {
      runner.enqueue("feed-poll", {
        singletonKey: `feed-poll-${floorToInterval(now(), 300_000)}`,
        maxAttempts: 1,
      });
    }),
    // Market data refresh two minutes past the hour (after the decision loop has been queued; runner is sequential).
    new Cron("*/15 * * * *", { timezone: "UTC" }, () => {
      runner.enqueue("market-refresh", {
        singletonKey: `market-refresh-${floorToInterval(now(), 900_000)}`,
        maxAttempts: 2,
      });
    }),
    // Position monitor safety net every minute (the WebSocket path is primary).
    new Cron("* * * * *", { timezone: "UTC" }, () => {
      runner.enqueue("monitor-tick", {
        singletonKey: `monitor-${floorToInterval(now(), 60_000)}`,
        maxAttempts: 1,
      });
    }),
    // Daily brief in the operator's zone.
    new Cron(`${bm} ${bh} * * *`, { timezone: tz }, () => {
      runner.enqueue("daily-brief", {
        singletonKey: `daily-brief-${new Date(now()).toISOString().slice(0, 10)}`,
        maxAttempts: 2,
      });
    }),
    // Weekly calibration, Sunday 03:00 in operator zone.
    new Cron("0 3 * * 0", { timezone: tz }, () => {
      runner.enqueue("calibration", {
        singletonKey: `calibration-${new Date(now()).toISOString().slice(0, 10)}`,
        maxAttempts: 1,
      });
    }),
    // Housekeeping: prune old jobs daily.
    new Cron("30 4 * * *", { timezone: "UTC" }, () => {
      const n = runner.prune(7 * 86_400_000);
      log.info({ pruned: n }, "pruned old jobs");
    }),
  ];
  log.info({ schedules: crons.length, tz, dailyBriefTime: opts.dailyBriefTime }, "schedules started");
  return { stop: () => crons.forEach((c) => c.stop()) };
}
