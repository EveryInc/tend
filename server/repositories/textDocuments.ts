import { existsSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeText } from "../util";

export interface TextDocumentSeed {
  key: string;
  content: string;
}

export interface TextDocumentRepository {
  init(): Promise<void>;
  ensure(seed: TextDocumentSeed): Promise<void>;
  has(key: string): Promise<boolean>;
  read(key: string): Promise<string>;
  write(key: string, content: string): Promise<void>;
}

export class FileTextDocumentRepository implements TextDocumentRepository {
  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {}

  async ensure(seed: TextDocumentSeed): Promise<void> {
    if (!(await this.has(seed.key))) await this.write(seed.key, seed.content);
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.file(key));
  }

  async read(key: string): Promise<string> {
    return readFile(this.file(key), "utf8");
  }

  async write(key: string, content: string): Promise<void> {
    await writeText(this.file(key), content);
  }

  private file(key: string): string {
    return path.join(this.dataDir, key);
  }
}

export class MirroredTextDocumentRepository implements TextDocumentRepository {
  constructor(private readonly primary: TextDocumentRepository, private readonly mirror: TextDocumentRepository) {}

  async init(): Promise<void> {
    await this.mirror.init();
    await this.primary.init();
  }

  async ensure(seed: TextDocumentSeed): Promise<void> {
    await this.syncSeed(seed);
  }

  has(key: string): Promise<boolean> {
    return this.primary.has(key);
  }

  read(key: string): Promise<string> {
    return this.primary.read(key);
  }

  async write(key: string, content: string): Promise<void> {
    await this.primary.write(key, content);
    await this.mirror.write(key, content);
  }

  private async syncSeed(seed: TextDocumentSeed): Promise<void> {
    const [primaryHas, mirrorHas] = await Promise.all([this.primary.has(seed.key), this.mirror.has(seed.key)]);
    if (!primaryHas && mirrorHas) {
      await this.primary.write(seed.key, await this.mirror.read(seed.key));
      return;
    }
    if (primaryHas && !mirrorHas) {
      await this.mirror.write(seed.key, await this.primary.read(seed.key));
      return;
    }
    if (!primaryHas && !mirrorHas) {
      await this.primary.write(seed.key, seed.content);
      await this.mirror.write(seed.key, seed.content);
    }
  }
}
