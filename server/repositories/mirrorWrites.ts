type MirrorWrite = () => Promise<void>;

export class MirrorWriteCoordinator {
  private pending: MirrorWrite[] | null = null;

  begin(): void {
    if (this.pending) throw new Error("A mirror transaction is already active.");
    this.pending = [];
  }

  async write(callback: MirrorWrite): Promise<void> {
    if (this.pending) {
      this.pending.push(callback);
      return;
    }
    await callback();
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      const result = await callback();
      await this.commit();
      return result;
    } catch (error) {
      this.pending = null;
      throw error;
    }
  }

  private async commit(): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new Error("No mirror transaction is active.");
    this.pending = null;
    for (const write of pending) {
      try {
        await write();
      } catch (error) {
        console.error("SQLite committed, but a filesystem mirror write failed:", error);
      }
    }
  }
}
