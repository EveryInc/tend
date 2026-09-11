import type { MobileCommandProgress, MobileCommandResult, MobileSyncStatus } from "../../shared/mobile";
import type { AttentionDomain } from "../domain";
import type { AttentionStore } from "../store";
import type { MobileCloudClient } from "./client";
import { projectMobileWorkspace, sanitizeText } from "./projection";

export interface MobileSyncWorkerOptions {
  intervalMs?: number;
  fullReconcileMs?: number;
  now?: () => Date;
  onStatus?: (status: MobileSyncStatus) => void;
}

export class MobileSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastFullReconcileAt = 0;
  private status: MobileSyncStatus = { enabled: true };
  private readonly options: Required<Pick<MobileSyncWorkerOptions, "intervalMs" | "fullReconcileMs" | "now">> & MobileSyncWorkerOptions;

  constructor(
    private readonly store: AttentionStore,
    private readonly domain: AttentionDomain,
    private readonly client: MobileCloudClient,
    options: MobileSyncWorkerOptions = {},
  ) {
    this.options = {
      intervalMs: 2_500,
      fullReconcileMs: 60_000,
      now: () => new Date(),
      ...options,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    void this.runOnce();
    console.log(`[mobile-sync] watching every ${Math.round(this.options.intervalMs / 100) / 10}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  currentStatus(): MobileSyncStatus {
    return { ...this.status };
  }

  async runOnce(): Promise<MobileSyncStatus> {
    if (this.running) return this.currentStatus();
    this.running = true;
    try {
      const now = this.options.now();
      const snapshot = await projectMobileWorkspace(this.store, now);
      const shouldPush = snapshot.generation !== this.status.snapshotGeneration
        || now.getTime() - this.lastFullReconcileAt >= this.options.fullReconcileMs;
      if (shouldPush) {
        await this.client.replaceSnapshot(snapshot);
        this.lastFullReconcileAt = now.getTime();
        this.setStatus({
          ...this.status,
          enabled: true,
          snapshotGeneration: snapshot.generation,
          lastPushAt: now.toISOString(),
        });
      }

      await this.client.syncCommandProgress(await this.commandProgress());
      const commands = await this.client.claimCommands();
      this.setStatus({ ...this.status, lastPullAt: now.toISOString() });
      for (const command of commands) {
        let result: MobileCommandResult;
        try {
          result = await this.domain.applyMobileCommand(command);
        } catch (error) {
          await this.client.completeCommand(command.id, "rejected", {
            error: sanitizeText(error instanceof Error ? error.message : String(error)),
          });
          continue;
        }
        await this.client.completeCommand(command.id, "applied", { workId: result.workId });
      }
      if (commands.length) {
        const refreshed = await projectMobileWorkspace(this.store, this.options.now());
        await this.client.replaceSnapshot(refreshed);
        this.lastFullReconcileAt = this.options.now().getTime();
        this.setStatus({
          ...this.status,
          snapshotGeneration: refreshed.generation,
          lastPushAt: this.options.now().toISOString(),
        });
      }
      this.setStatus({
        ...this.status,
        lastSuccessAt: this.options.now().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      this.setStatus({
        ...this.status,
        lastError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
    return this.currentStatus();
  }

  private async commandProgress(): Promise<MobileCommandProgress[]> {
    const progress: MobileCommandProgress[] = [];
    for (const feedId of await this.store.listFeedIds()) {
      for (const work of await this.store.readWorkItems(feedId)) {
        if (!work.sourceMobileCommandId) continue;
        progress.push({
          commandId: work.sourceMobileCommandId,
          workId: work.id,
          workStatus: work.status,
          ...(work.response ? { response: sanitizeText(work.response) } : {}),
          ...(work.error ? { error: sanitizeText(work.error) } : {}),
          updatedAt: work.updatedAt,
        });
      }
    }
    return progress;
  }

  private setStatus(status: MobileSyncStatus): void {
    this.status = status;
    this.options.onStatus?.(this.currentStatus());
  }
}
