// Capability type for `host.experienceHarvester`.
//
// Plugins obtain this via:
//   ctx.capabilities.get<ExperienceHarvesterCapability>("host.experienceHarvester")

export interface HarvestProgress {
  step: "organise" | "analyse" | "idle";
  current: number;
  total: number;
  label?: string;
}

export interface HarvestStatus {
  eventFiles: number;
  totalEvents: number;
  insightFiles: number;
  categories: string[];
  progress: HarvestProgress | null;
  activeOid: string | null;
}

export interface OrganiseResult {
  sessionsProcessed: number;
  eventsFound: number;
  filesWritten: string[];
  skipped: boolean;
  reason?: string;
  cutoffMs?: number;
}

export interface InsightVersion {
  oid: string;
  message: string;
  timestamp: number;
}

export interface ExperienceHarvesterCapability {
  /** Get current harvest status (event/insight counts, progress). */
  getStatus(userId: string): HarvestStatus;

  /** Get current progress for a user. */
  getProgress(userId: string): HarvestProgress;

  /** Set progress (used by analyse route). */
  setProgress(userId: string, p: HarvestProgress): void;

  /** Organise session history into event files. */
  organise(userId: string, opts: { fresh?: boolean }): Promise<OrganiseResult>;

  /** List event files. */
  listEvents(userId: string): Array<{ file: string; sessionId: string | null; createdAt: string | null; eventCount: number; sizeBytes: number }>;

  /** Read an event or insight file. */
  readFile(userId: string, type: "events" | "insights", file: string): string | null;

  /** List insight files. */
  listInsights(userId: string): Array<{ file: string; type: string; createdAt: string | null; sizeBytes: number; preview: string }>;

  /** Get insight version history (git). */
  getHistory(userId: string, limit?: number): Promise<InsightVersion[]>;

  /** Rollback insights to a specific git commit. */
  rollback(userId: string, oid: string): Promise<{ ok: boolean; message: string }>;

  /** Clear all event files (for fresh organise). */
  clearEvents(userId: string): void;

  /** Get the user home directory path. */
  getUserHome(userId: string): string;
}
