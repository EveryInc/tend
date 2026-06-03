import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PolicyRevision, RevisionProposal, WorkspaceRevision } from "../../src/types";
import { readJson, writeJson } from "../util";

export interface RevisionRepository {
  init(feedIds: string[]): Promise<void>;
  listProposals(): Promise<RevisionProposal[]>;
  getProposal(proposalId: string): Promise<RevisionProposal>;
  writeProposal(proposal: RevisionProposal): Promise<void>;
  listWorkspaceRevisions(): Promise<WorkspaceRevision[]>;
  getWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision>;
  writeWorkspaceRevision(revision: WorkspaceRevision): Promise<void>;
  listPolicyRevisions(feedId: string): Promise<PolicyRevision[]>;
  getPolicyRevision(feedId: string, revisionId: string): Promise<PolicyRevision>;
  writePolicyRevision(revision: PolicyRevision): Promise<void>;
}

export class FileRevisionRepository implements RevisionRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  listProposals(): Promise<RevisionProposal[]> {
    return this.listJson<RevisionProposal>(path.join(this.dataDir, "revision-proposals"));
  }

  getProposal(proposalId: string): Promise<RevisionProposal> {
    return readJson<RevisionProposal>(path.join(this.dataDir, "revision-proposals", `${proposalId}.json`));
  }

  async writeProposal(proposal: RevisionProposal): Promise<void> {
    await writeJson(path.join(this.dataDir, "revision-proposals", `${proposal.id}.json`), proposal);
  }

  listWorkspaceRevisions(): Promise<WorkspaceRevision[]> {
    return this.listJson<WorkspaceRevision>(path.join(this.dataDir, "workspace-revisions"));
  }

  getWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision> {
    return readJson<WorkspaceRevision>(path.join(this.dataDir, "workspace-revisions", `${revisionId}.json`));
  }

  async writeWorkspaceRevision(revision: WorkspaceRevision): Promise<void> {
    await writeJson(path.join(this.dataDir, "workspace-revisions", `${revision.id}.json`), revision);
  }

  listPolicyRevisions(feedId: string): Promise<PolicyRevision[]> {
    return this.listJson<PolicyRevision>(this.policyPath(feedId));
  }

  getPolicyRevision(feedId: string, revisionId: string): Promise<PolicyRevision> {
    return readJson<PolicyRevision>(path.join(this.policyPath(feedId), `${revisionId}.json`));
  }

  async writePolicyRevision(revision: PolicyRevision): Promise<void> {
    await writeJson(path.join(this.policyPath(revision.feedId), `${revision.id}.json`), revision);
  }

  private async listJson<T>(directory: string): Promise<T[]> {
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<T>(path.join(directory, file))));
  }

  private policyPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "policy-revisions");
  }
}

export class MirroredRevisionRepository implements RevisionRepository {
  constructor(private readonly primary: RevisionRepository, private readonly mirror: RevisionRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    await this.syncProposals();
    await this.syncWorkspaceRevisions();
    for (const feedId of feedIds) await this.syncPolicyRevisions(feedId);
  }

  listProposals(): Promise<RevisionProposal[]> {
    return this.primary.listProposals();
  }

  getProposal(proposalId: string): Promise<RevisionProposal> {
    return this.primary.getProposal(proposalId);
  }

  async writeProposal(proposal: RevisionProposal): Promise<void> {
    await this.primary.writeProposal(proposal);
    await this.mirror.writeProposal(proposal);
  }

  listWorkspaceRevisions(): Promise<WorkspaceRevision[]> {
    return this.primary.listWorkspaceRevisions();
  }

  getWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision> {
    return this.primary.getWorkspaceRevision(revisionId);
  }

  async writeWorkspaceRevision(revision: WorkspaceRevision): Promise<void> {
    await this.primary.writeWorkspaceRevision(revision);
    await this.mirror.writeWorkspaceRevision(revision);
  }

  listPolicyRevisions(feedId: string): Promise<PolicyRevision[]> {
    return this.primary.listPolicyRevisions(feedId);
  }

  getPolicyRevision(feedId: string, revisionId: string): Promise<PolicyRevision> {
    return this.primary.getPolicyRevision(feedId, revisionId);
  }

  async writePolicyRevision(revision: PolicyRevision): Promise<void> {
    await this.primary.writePolicyRevision(revision);
    await this.mirror.writePolicyRevision(revision);
  }

  private async syncProposals(): Promise<void> {
    const primary = await this.primary.listProposals();
    const mirror = await this.mirror.listProposals();
    await this.syncById(primary, mirror, (item) => item.id, (item) => this.primary.writeProposal(item), (item) => this.mirror.writeProposal(item));
  }

  private async syncWorkspaceRevisions(): Promise<void> {
    const primary = await this.primary.listWorkspaceRevisions();
    const mirror = await this.mirror.listWorkspaceRevisions();
    await this.syncById(primary, mirror, (item) => item.id, (item) => this.primary.writeWorkspaceRevision(item), (item) => this.mirror.writeWorkspaceRevision(item));
  }

  private async syncPolicyRevisions(feedId: string): Promise<void> {
    const primary = await this.primary.listPolicyRevisions(feedId);
    const mirror = await this.mirror.listPolicyRevisions(feedId);
    await this.syncById(primary, mirror, (item) => item.id, (item) => this.primary.writePolicyRevision(item), (item) => this.mirror.writePolicyRevision(item));
  }

  private async syncById<T>(primary: T[], mirror: T[], id: (item: T) => string, writePrimary: (item: T) => Promise<void>, writeMirror: (item: T) => Promise<void>): Promise<void> {
    const primaryIds = new Set(primary.map(id));
    const mirrorIds = new Set(mirror.map(id));
    for (const item of mirror.filter((candidate) => !primaryIds.has(id(candidate)))) await writePrimary(item);
    for (const item of primary.filter((candidate) => !mirrorIds.has(id(candidate)))) await writeMirror(item);
  }
}
