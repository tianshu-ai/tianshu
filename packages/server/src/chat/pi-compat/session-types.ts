// Local session/storage types extracted from pi-agent-core 0.87.1.
//
// pi-agent-core 1.0 removed the entire harness/ layer including
// Session, Storage, Entry, and StorageBackedSession. Tianshu's
// sqlite persistence code still needs these contracts — they are
// frozen here as the tianshu-owned persistence API.
//
// Runtime behaviour is unchanged: SqliteStorage implements Storage,
// StorageBackedSession wraps Storage into Session.

import { randomUUID } from "node:crypto";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "./context.js";

// ─── Entry types ──────────────────────────────────────────────

export type EntryType = "message" | "compaction" | "branch_summary" | "custom";

export interface EntryBase {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  type: EntryType;
  customType?: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
  terminate?: true;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

export type Entry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;

/** Entry supplied to a transaction before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "seq" | "timestamp">
  : never;

// ─── Value / KV types ─────────────────────────────────────────

declare const storedValueType: unique symbol;

export interface StoredAddressBase {
  readonly namespace: string;
  readonly key: string;
  readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
  readonly kind: "value";
  readonly [storedValueType]?: (value: T) => T;
}

export interface ValueList<T> extends StoredAddressBase {
  readonly kind: "list";
  readonly [storedValueType]?: (value: T) => T;
}

export interface StoredValue<T> {
  address: Value<T>;
  value: T;
  seq: number;
}

export interface ListElement<T> {
  seq: number;
  value: T;
}

export interface ListCursor {
  seq: number;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
}

// ─── Write types ──────────────────────────────────────────────

export interface ValueSetWrite {
  kind: "value";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

export interface ValueDeleteWrite {
  kind: "value";
  op: "delete";
  namespace: string;
  key: string;
}

export interface ListAppendWrite {
  kind: "list";
  op: "append";
  namespace: string;
  key: string;
  value: unknown;
}

export interface ListDeleteWrite {
  kind: "list";
  op: "delete";
  namespace: string;
  key: string;
}

export type ValueWrite = ValueSetWrite | ValueDeleteWrite;
export type ListWrite = ListAppendWrite | ListDeleteWrite;

export interface EntryWrite {
  kind: "entry";
  entry: NewEntry;
}

export interface UsageWrite {
  kind: "usage";
  row: Omit<UsageRow, "seq">;
}

export type Write = EntryWrite | UsageWrite | ValueWrite | ListWrite;

// ─── Scan / Stats types ──────────────────────────────────────

export interface CommitResult {
  firstSeq: number;
  seqs: number[];
  timestamp: number;
  /** Session totals immediately after this commit was applied. */
  stats: SessionStats;
}

export interface SessionStats {
  messageCount: number;
  usage: Usage;
}

export interface EntryStructure {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  type: EntryType;
  customType?: string;
}

export interface EntryCursor {
  seq: number;
}

export interface BranchScan {
  start?: string;
  stopAtType?: EntryType;
  stopAtId?: string;
  type?: EntryType;
  customType?: string;
  order?: "newestFirst" | "oldestFirst";
  limit?: number;
  cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
  type?: EntryType;
  customType?: string;
  fromSeq?: number;
  toSeq?: number;
  order?: "asc" | "desc";
  limit?: number;
}

export interface UsageRow {
  id: string;
  seq: number;
  usage: Usage;
  entryId?: string;
  adjustment: boolean;
  details?: JsonValue;
}

export interface UsageScan {
  fromSeq?: number;
  toSeq?: number;
  order?: "asc" | "desc";
  limit?: number;
}

// ─── Storage interface ────────────────────────────────────────

export interface Storage {
  commit(writes: Write[], context: Context): Promise<CommitResult>;
  getEntries(
    ids: string[],
    context: Context,
  ): Promise<Map<string, Entry>>;
  getValue<T>(
    address: Value<T>,
    context: Context,
  ): Promise<StoredValue<T> | undefined>;
  scanValues<T>(
    prefix: Value<T>,
    context: Context,
  ): Promise<StoredValue<T>[]>;
  readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    context: Context,
  ): Promise<ListElement<T>[]>;
  scanBranch(
    query: StorageBranchScan,
    context: Context,
  ): Promise<Entry[]>;
  scanBranchStructure(
    query: StorageBranchScan,
    context: Context,
  ): Promise<EntryStructure[]>;
  scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
  scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]>;
  getStats(context: Context): Promise<SessionStats>;
  close(context: Context): Promise<void>;
}

// ─── SessionMetadata ──────────────────────────────────────────

export interface SessionMetadata {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd?: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
}

// ─── IdGenerator ──────────────────────────────────────────────

export interface IdGenerator {
  next(timestampMs?: number): string;
}

// ─── EntryQuery ───────────────────────────────────────────────

export interface EntryQuery {
  type?: EntryType;
  customType?: string;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: EntryCursor;
}

// ─── Branch ───────────────────────────────────────────────────

export interface Branch {
  readonly name: string;
  getTipId(context: Context): Promise<string | null>;
  findEntries(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: BranchScan | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  appendMessage(
    message: AgentMessage,
    context: Context,
  ): Promise<string>;
  appendCustomEntry(
    customType: string,
    data: JsonValue | undefined,
    context: Context,
  ): Promise<string>;
}

// ─── SessionReader ────────────────────────────────────────────

export interface SessionReader {
  getEntries(
    ids: string[],
    context: Context,
  ): Promise<Map<string, Entry>>;
  getStats(context: Context): Promise<SessionStats>;
  getValue<T>(
    address: Value<T>,
    context: Context,
  ): Promise<StoredValue<T> | undefined>;
  scanValues<T>(
    prefix: Value<T>,
    context: Context,
  ): Promise<StoredValue<T>[]>;
  readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    context: Context,
  ): Promise<ListElement<T>[]>;
  scanBranch(
    query: StorageBranchScan,
    context: Context,
  ): Promise<Entry[]>;
}

// ─── SessionMutation ──────────────────────────────────────────

export interface SessionMutation extends SessionReader {
  /** Exactly zero or one commit attempt. A second attempt rejects. */
  commit(writes: Write[], context: Context): Promise<CommitResult>;
  /** Wait for any commit attempt, invalidate the capability, and release the barrier. */
  end(context: Context): Promise<void>;
}

/** Callback-scoped mutation capability without authority to release its Session barrier. */
export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<T> = (
  mutator: SessionMutator,
  context: Context,
) => T | Promise<T>;

// ─── Session interface ────────────────────────────────────────

export interface Session<
  TMetadata extends SessionMetadata = SessionMetadata,
> extends SessionReader {
  readonly metadata: TMetadata;
  readonly idGenerator: IdGenerator;
  getEntry(
    id: string,
    context: Context,
  ): Promise<Entry | undefined>;
  getStats(context: Context): Promise<SessionStats>;
  getName(context: Context): Promise<string | undefined>;
  getLabel(
    targetId: string,
    context: Context,
  ): Promise<string | undefined>;
  findEntries(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry[]>;
  findEntry(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry | undefined>;
  branch(
    name: string,
    context: Context,
  ): Promise<Branch | undefined>;
  createBranch(
    name: string,
    at: string | null,
    context: Context,
  ): Promise<Branch>;
  beginMutation(context: Context): Promise<SessionMutation>;
  mutate<T>(
    mutation: SessionMutationCallback<T>,
    context: Context,
  ): Promise<T>;
  setValue<T>(
    address: Value<T>,
    next: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteValue<T>(
    address: Value<T>,
    context: Context,
  ): Promise<void>;
  appendList<T>(
    address: ValueList<T>,
    element: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteList<T>(
    address: ValueList<T>,
    context: Context,
  ): Promise<void>;
  setName(
    name: string | undefined,
    context: Context,
  ): Promise<void>;
  setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void>;
  close(context: Context): Promise<void>;
}

// ─── ForkOptions ──────────────────────────────────────────────

export type ForkOptions =
  | {
      scope: "branch";
      branch: string;
      entryId?: string;
      position?: "before" | "at";
      id?: string;
    }
  | {
      scope: "tree";
      id?: string;
    };

// ─── SessionRepo ──────────────────────────────────────────────

export interface SessionRepo<
  TMetadata extends SessionMetadata = SessionMetadata,
  TCreateOptions extends {
    id?: string;
    parentSessionId?: string;
  } = { id?: string; parentSessionId?: string },
  TListOptions = void,
> {
  create(
    options: TCreateOptions,
    context: Context,
  ): Promise<Session<TMetadata>>;
  open(
    metadata: TMetadata,
    context: Context,
  ): Promise<Session<TMetadata>>;
  list(
    options: TListOptions | undefined,
    context: Context,
  ): Promise<TMetadata[]>;
  delete(
    metadata: TMetadata,
    context: Context,
  ): Promise<void>;
  fork(
    source: TMetadata,
    options: ForkOptions,
    context: Context,
  ): Promise<Session<TMetadata>>;
}

// ─── Value address helpers (internal to StorageBackedSession) ─

function valueAddr<T>(namespace: string, key = ""): Value<T> {
  return Object.freeze({
    namespace,
    key,
    kind: "value" as const,
  }) as Value<T>;
}

const SESSION_NAME_ADDR = valueAddr<string>("pi.session.name");
const entryLabelAddr = (entryId: string) =>
  valueAddr<string>("pi.entry.label", entryId);

// ─── StorageBackedSession ─────────────────────────────────────
//
// Wraps a Storage implementation into the full Session interface.
// Delegates all storage ops; branch management is stubbed (tianshu
// uses single-branch sessions). Mutation barrier is simplified.
//
// This replaces the pi-agent-core 0.87 StorageBackedSession class
// that was removed in 1.0. Runtime behaviour is preserved for all
// code paths tianshu exercises.

export class StorageBackedSession<T extends SessionMetadata>
  implements Session<T>
{
  readonly metadata: T;
  readonly idGenerator: IdGenerator;
  private readonly storage: Storage;

  constructor(metadata: T, storage: Storage) {
    this.metadata = metadata;
    this.storage = storage;
    this.idGenerator = {
      next(_timestampMs?: number): string {
        return `entry_${randomUUID()}`;
      },
    };
  }

  // ── SessionReader (delegate to Storage) ──

  async getEntries(
    ids: string[],
    context: Context,
  ): Promise<Map<string, Entry>> {
    return this.storage.getEntries(ids, context);
  }

  async getStats(context: Context): Promise<SessionStats> {
    return this.storage.getStats(context);
  }

  async getValue<V>(
    address: Value<V>,
    context: Context,
  ): Promise<StoredValue<V> | undefined> {
    return this.storage.getValue(address, context);
  }

  async scanValues<V>(
    prefix: Value<V>,
    context: Context,
  ): Promise<StoredValue<V>[]> {
    return this.storage.scanValues(prefix, context);
  }

  async readList<V>(
    address: ValueList<V>,
    options: ListReadOptions | undefined,
    context: Context,
  ): Promise<ListElement<V>[]> {
    return this.storage.readList(address, options, context);
  }

  async scanBranch(
    query: StorageBranchScan,
    context: Context,
  ): Promise<Entry[]> {
    return this.storage.scanBranch(query, context);
  }

  // ── Session methods ──

  async getEntry(
    id: string,
    context: Context,
  ): Promise<Entry | undefined> {
    const map = await this.storage.getEntries([id], context);
    return map.get(id);
  }

  async getName(context: Context): Promise<string | undefined> {
    const stored = await this.storage.getValue(
      SESSION_NAME_ADDR,
      context,
    );
    return stored?.value;
  }

  async getLabel(
    targetId: string,
    context: Context,
  ): Promise<string | undefined> {
    const stored = await this.storage.getValue(
      entryLabelAddr(targetId),
      context,
    );
    return stored?.value;
  }

  async findEntries(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry[]> {
    return this.storage.scanEntries(query ?? {}, context);
  }

  async findEntry(
    query: EntryQuery | undefined,
    context: Context,
  ): Promise<Entry | undefined> {
    const entries = await this.findEntries(
      query ? { ...query, limit: 1 } : { limit: 1 },
      context,
    );
    return entries[0];
  }

  async branch(
    _name: string,
    _context: Context,
  ): Promise<Branch | undefined> {
    // Tianshu uses single-branch sessions; branch lookup is not exercised.
    return undefined;
  }

  async createBranch(
    _name: string,
    _at: string | null,
    _context: Context,
  ): Promise<Branch> {
    throw new Error("StorageBackedSession.createBranch not implemented");
  }

  async beginMutation(context: Context): Promise<SessionMutation> {
    // Simplified barrier: no real mutex. Tianshu's commit path is
    // already serialised by the sqlite transaction in SqliteStorage.
    let committed = false;
    const self = this;
    const mutation: SessionMutation = {
      getEntries: (ids, ctx) => self.storage.getEntries(ids, ctx),
      getStats: (ctx) => self.storage.getStats(ctx),
      getValue: <V>(addr: Value<V>, ctx: Context) =>
        self.storage.getValue(addr, ctx),
      scanValues: <V>(prefix: Value<V>, ctx: Context) =>
        self.storage.scanValues(prefix, ctx),
      readList: <V>(
        addr: ValueList<V>,
        opts: ListReadOptions | undefined,
        ctx: Context,
      ) => self.storage.readList(addr, opts, ctx),
      scanBranch: (q, ctx) => self.storage.scanBranch(q, ctx),
      commit: async (writes, ctx) => {
        if (committed)
          throw new Error("SessionMutation: already committed");
        committed = true;
        return self.storage.commit(writes, ctx);
      },
      end: async () => {
        /* release — nothing to do */
      },
    };
    return mutation;
  }

  async mutate<R>(
    callback: SessionMutationCallback<R>,
    context: Context,
  ): Promise<R> {
    const mutation = await this.beginMutation(context);
    try {
      const result = await callback(mutation, context);
      await mutation.end(context);
      return result;
    } catch (err) {
      await mutation.end(context);
      throw err;
    }
  }

  async setValue<V>(
    address: Value<V>,
    next: NoInfer<V>,
    context: Context,
  ): Promise<void> {
    const write: ValueSetWrite = {
      kind: "value",
      op: "set",
      namespace: address.namespace,
      key: address.key,
      value: next,
    };
    await this.storage.commit([write], context);
  }

  async deleteValue<V>(
    address: Value<V>,
    context: Context,
  ): Promise<void> {
    const write: ValueDeleteWrite = {
      kind: "value",
      op: "delete",
      namespace: address.namespace,
      key: address.key,
    };
    await this.storage.commit([write], context);
  }

  async appendList<V>(
    address: ValueList<V>,
    element: NoInfer<V>,
    context: Context,
  ): Promise<void> {
    const write: ListAppendWrite = {
      kind: "list",
      op: "append",
      namespace: address.namespace,
      key: address.key,
      value: element,
    };
    await this.storage.commit([write], context);
  }

  async deleteList<V>(
    address: ValueList<V>,
    context: Context,
  ): Promise<void> {
    const write: ListDeleteWrite = {
      kind: "list",
      op: "delete",
      namespace: address.namespace,
      key: address.key,
    };
    await this.storage.commit([write], context);
  }

  async setName(
    name: string | undefined,
    context: Context,
  ): Promise<void> {
    if (name === undefined) {
      await this.deleteValue(SESSION_NAME_ADDR, context);
    } else {
      await this.setValue(SESSION_NAME_ADDR, name, context);
    }
  }

  async setLabel(
    targetId: string,
    label: string | undefined,
    context: Context,
  ): Promise<void> {
    const addr = entryLabelAddr(targetId);
    if (label === undefined) {
      await this.deleteValue(addr, context);
    } else {
      await this.setValue(addr, label, context);
    }
  }

  async close(context: Context): Promise<void> {
    await this.storage.close(context);
  }
}
