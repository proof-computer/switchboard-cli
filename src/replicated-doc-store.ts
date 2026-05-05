import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ReplicatedDocument<T> {
  id: string;
  rev: string;
  sequence: number;
  updatedAt: string;
  value: T;
  deleted?: boolean;
}

export interface ReplicatedChange<T> {
  sequence: number;
  id: string;
  rev: string;
  updatedAt: string;
  deleted?: boolean;
  value?: T;
}

export interface ReplicatedLease {
  name: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface PutDocumentOptions {
  expectedRev?: string;
}

export interface DeleteDocumentOptions {
  expectedRev?: string;
}

export interface AcquireLeaseOptions {
  now?: Date;
  ttlMs: number;
}

export interface ReplicatedDocumentStore<T> {
  get(id: string): Promise<ReplicatedDocument<T> | undefined>;
  list(): Promise<Array<ReplicatedDocument<T>>>;
  put(id: string, value: T, options?: PutDocumentOptions): Promise<ReplicatedDocument<T>>;
  delete(id: string, options?: DeleteDocumentOptions): Promise<ReplicatedDocument<T>>;
  changesSince(sequence: number): Promise<Array<ReplicatedChange<T>>>;
  acquireLease(name: string, ownerId: string, options: AcquireLeaseOptions): Promise<ReplicatedLease | undefined>;
  releaseLease(name: string, token: string): Promise<boolean>;
}

export class RevisionConflictError extends Error {
  constructor(id: string, expectedRev: string | undefined, actualRev: string | undefined) {
    super(`Revision conflict for ${id}: expected ${expectedRev ?? "<none>"}, actual ${actualRev ?? "<none>"}`);
    this.name = "RevisionConflictError";
  }
}

export class InvalidLeaseTtlError extends Error {
  constructor(ttlMs: number) {
    super(`Lease ttlMs must be positive, got ${ttlMs}`);
    this.name = "InvalidLeaseTtlError";
  }
}

interface StoreSnapshot<T> {
  sequence: number;
  documents: Record<string, ReplicatedDocument<T>>;
  changes: Array<ReplicatedChange<T>>;
  leases: Record<string, ReplicatedLease>;
}

export class MemoryReplicatedDocumentStore<T> implements ReplicatedDocumentStore<T> {
  private snapshot: StoreSnapshot<T>;

  constructor(snapshot?: Partial<StoreSnapshot<T>>) {
    this.snapshot = {
      sequence: snapshot?.sequence ?? 0,
      documents: { ...(snapshot?.documents ?? {}) },
      changes: [...(snapshot?.changes ?? [])],
      leases: { ...(snapshot?.leases ?? {}) }
    };
  }

  async get(id: string): Promise<ReplicatedDocument<T> | undefined> {
    const document = this.snapshot.documents[id];
    return document && !document.deleted ? cloneJson(document) : undefined;
  }

  async list(): Promise<Array<ReplicatedDocument<T>>> {
    return Object.values(this.snapshot.documents)
      .filter((document) => !document.deleted)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => cloneJson(document));
  }

  async put(id: string, value: T, options: PutDocumentOptions = {}): Promise<ReplicatedDocument<T>> {
    const existing = this.snapshot.documents[id];
    assertExpectedRevision(id, existing, options.expectedRev);

    const sequence = this.nextSequence();
    const document: ReplicatedDocument<T> = {
      id,
      rev: nextRevision(existing?.rev, sequence, value),
      sequence,
      updatedAt: new Date().toISOString(),
      value: cloneJson(value)
    };
    this.snapshot.documents[id] = document;
    this.snapshot.changes.push(changeFromDocument(document));
    return cloneJson(document);
  }

  async delete(id: string, options: DeleteDocumentOptions = {}): Promise<ReplicatedDocument<T>> {
    const existing = this.snapshot.documents[id];
    assertExpectedRevision(id, existing, options.expectedRev);
    if (!existing) {
      throw new RevisionConflictError(id, options.expectedRev, undefined);
    }

    const sequence = this.nextSequence();
    const document: ReplicatedDocument<T> = {
      ...existing,
      rev: nextRevision(existing.rev, sequence, existing.value),
      sequence,
      updatedAt: new Date().toISOString(),
      deleted: true
    };
    this.snapshot.documents[id] = document;
    this.snapshot.changes.push(changeFromDocument(document));
    return cloneJson(document);
  }

  async changesSince(sequence: number): Promise<Array<ReplicatedChange<T>>> {
    return this.snapshot.changes
      .filter((change) => change.sequence > sequence)
      .sort((left, right) => left.sequence - right.sequence)
      .map((change) => cloneJson(change));
  }

  async acquireLease(name: string, ownerId: string, options: AcquireLeaseOptions): Promise<ReplicatedLease | undefined> {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new InvalidLeaseTtlError(options.ttlMs);
    }
    const now = options.now ?? new Date();
    const existing = this.snapshot.leases[name];
    if (existing && Date.parse(existing.expiresAt) > now.getTime() && existing.ownerId !== ownerId) {
      return undefined;
    }

    const lease: ReplicatedLease = {
      name,
      ownerId,
      token: randomBytes(16).toString("hex"),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + options.ttlMs).toISOString()
    };
    this.snapshot.leases[name] = lease;
    return cloneJson(lease);
  }

  async releaseLease(name: string, token: string): Promise<boolean> {
    const existing = this.snapshot.leases[name];
    if (!existing || existing.token !== token) {
      return false;
    }
    delete this.snapshot.leases[name];
    return true;
  }

  protected async load(): Promise<StoreSnapshot<T>> {
    return this.snapshot;
  }

  protected async save(snapshot: StoreSnapshot<T>): Promise<void> {
    this.snapshot = snapshot;
  }

  protected currentSnapshot(): StoreSnapshot<T> {
    return this.snapshot;
  }

  private nextSequence(): number {
    this.snapshot.sequence += 1;
    return this.snapshot.sequence;
  }
}

export class JsonFileReplicatedDocumentStore<T> extends MemoryReplicatedDocumentStore<T> {
  constructor(private readonly filePath: string) {
    super();
  }

  override async get(id: string): Promise<ReplicatedDocument<T> | undefined> {
    await this.reload();
    return super.get(id);
  }

  override async list(): Promise<Array<ReplicatedDocument<T>>> {
    await this.reload();
    return super.list();
  }

  override async put(id: string, value: T, options: PutDocumentOptions = {}): Promise<ReplicatedDocument<T>> {
    await this.reload();
    const document = await super.put(id, value, options);
    await this.flush();
    return document;
  }

  override async delete(id: string, options: DeleteDocumentOptions = {}): Promise<ReplicatedDocument<T>> {
    await this.reload();
    const document = await super.delete(id, options);
    await this.flush();
    return document;
  }

  override async changesSince(sequence: number): Promise<Array<ReplicatedChange<T>>> {
    await this.reload();
    return super.changesSince(sequence);
  }

  override async acquireLease(name: string, ownerId: string, options: AcquireLeaseOptions): Promise<ReplicatedLease | undefined> {
    await this.reload();
    const lease = await super.acquireLease(name, ownerId, options);
    await this.flush();
    return lease;
  }

  override async releaseLease(name: string, token: string): Promise<boolean> {
    await this.reload();
    const released = await super.releaseLease(name, token);
    if (released) {
      await this.flush();
    }
    return released;
  }

  private async reload(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      await this.save(JSON.parse(raw) as StoreSnapshot<T>);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.save({
          sequence: 0,
          documents: {},
          changes: [],
          leases: {}
        });
        return;
      }
      throw error;
    }
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.currentSnapshot(), null, 2)}\n`, "utf8");
  }
}

function assertExpectedRevision<T>(
  id: string,
  existing: ReplicatedDocument<T> | undefined,
  expectedRev: string | undefined
): void {
  const actualRev = existing?.rev;
  if (existing && expectedRev !== actualRev) {
    throw new RevisionConflictError(id, expectedRev, actualRev);
  }
  if (!existing && expectedRev !== undefined) {
    throw new RevisionConflictError(id, expectedRev, undefined);
  }
}

function nextRevision(previousRev: string | undefined, sequence: number, value: unknown): string {
  const previousGeneration = previousRev ? Number(previousRev.split("-", 1)[0]) : 0;
  const generation = previousGeneration + 1;
  const hash = createHash("sha256")
    .update(JSON.stringify({ sequence, value }))
    .digest("hex")
    .slice(0, 16);
  return `${generation}-${hash}`;
}

function changeFromDocument<T>(document: ReplicatedDocument<T>): ReplicatedChange<T> {
  return {
    sequence: document.sequence,
    id: document.id,
    rev: document.rev,
    updatedAt: document.updatedAt,
    deleted: document.deleted,
    value: document.deleted ? undefined : cloneJson(document.value)
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
