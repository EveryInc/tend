import { existsSync } from "node:fs";
import path from "node:path";
import type { MobileCommandReceipt } from "../../shared/mobile";
import { readJson, writeJson } from "../util";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface MobileCommandReceiptRepository {
  init(): Promise<void>;
  has(commandId: string): Promise<boolean>;
  get(commandId: string): Promise<MobileCommandReceipt>;
  write(receipt: MobileCommandReceipt): Promise<void>;
}

export class FileMobileCommandReceiptRepository implements MobileCommandReceiptRepository {
  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {}

  async has(commandId: string): Promise<boolean> {
    return existsSync(this.file(commandId));
  }

  async get(commandId: string): Promise<MobileCommandReceipt> {
    return readJson<MobileCommandReceipt>(this.file(commandId));
  }

  async write(receipt: MobileCommandReceipt): Promise<void> {
    await writeJson(this.file(receipt.commandId), receipt);
  }

  private file(commandId: string): string {
    return path.join(this.dataDir, "mobile", "command-receipts", `${commandId}.json`);
  }
}

export class MirroredMobileCommandReceiptRepository implements MobileCommandReceiptRepository {
  constructor(
    private readonly primary: MobileCommandReceiptRepository,
    private readonly mirror: MobileCommandReceiptRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}

  async init(): Promise<void> {
    await this.primary.init();
    await this.mirror.init();
  }

  has(commandId: string): Promise<boolean> {
    return this.primary.has(commandId);
  }

  get(commandId: string): Promise<MobileCommandReceipt> {
    return this.primary.get(commandId);
  }

  async write(receipt: MobileCommandReceipt): Promise<void> {
    await this.primary.write(receipt);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.write(receipt));
    else await this.mirror.write(receipt);
  }
}
