import { setTimeout as wait } from "node:timers/promises";
import type { AppConfig, ScheduledTask } from "#core/types.ts";
import { readConfig } from "#core/config.ts";

export class Scheduler {
  private activeTasks: Map<string, boolean> = new Map();

  constructor(private config: AppConfig) {}

  /**
   * Starts the scheduling loop. This is a non-blocking call that manages
   * the execution of scheduled tasks based on their intervals or cron-like definitions.
   */
  async start() {
    console.log("Scheduler started. Monitoring scheduled tasks...");
    while (true) {
      try {
        await this.checkAndRunTasks();
        // Check every minute
        await wait(60 * 1000);
      } catch (e) {
        console.error("Scheduler loop error:", e);
        await wait(60 * 1000);
      }
    }
  }

  private async checkAndRunTasks() {
    const now = Date.now();
    const tasks = this.config.scheduledTasks || [];

    for (const task of tasks) {
      if (this.activeTasks.get(task.id)) continue;

      if (this.shouldRun(task, now)) {
        this.activeTasks.set(task.id, true);
        this.runTask(task).finally(() => {
          this.activeTasks.set(task.id, false);
        });
      }
    }
  }

  private shouldRun(task: ScheduledTask, now: number): boolean {
    if (task.intervalMinutes) {
      const lastRun = task.lastRun || 0;
      return now - lastRun >= task.intervalMinutes * 60 * 1000;
    }
    
    // Simple daily check if no interval is provided but it's a "daily" task
    // In a real implementation, this would use a cron parser.
    if (task.cron === "daily") {
      const lastRunDate = new Date(task.lastRun || 0).toDateString();
      const nowDate = new Date(now).toDateString();
      return lastRunDate !== nowDate;
    }

    return false;
  }

  private async runTask(task: ScheduledTask) {
    console.log(`Executing scheduled task: ${task.name} (${task.id})`);
    try {
      // Here we would integrate with the Foreman or Loop to execute the task template
      // For now, we log the execution.
      console.log(`Running template ${task.template} with args:`, task.args);
      
      // Update last run time
      task.lastRun = Date.now();
    } catch (e) {
      console.error(`Task ${task.id} failed:`, e);
    }
  }
}

export function createScheduler(config: AppConfig): Scheduler {
  return new Scheduler(config);
}
