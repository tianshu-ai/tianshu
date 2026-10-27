import type { DriverConfig, TrackerDriver } from "../types.js";
import { RedmineDriver } from "./redmine.js";

const DRIVERS: Record<string, new (cfg: DriverConfig) => TrackerDriver> = {
  redmine: RedmineDriver,
  // jira: JiraDriver,
  // leantime: LeantimeDriver,
  // linear: LinearDriver,
};

export function createDriver(cfg: DriverConfig): TrackerDriver {
  const Ctor = DRIVERS[cfg.driver];
  if (!Ctor) throw new Error(`Unknown projecthub driver: ${cfg.driver}. Available: ${Object.keys(DRIVERS).join(", ")}`);
  return new Ctor(cfg);
}

export function availableDrivers(): string[] {
  return Object.keys(DRIVERS);
}
