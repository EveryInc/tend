import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { importCardImage, readCardImage, verifyCardImages } from "../server/imageAttachments";
import { AttentionStore, readingContentRevision } from "../server/store";
import { actionDigest } from "../server/workflow/approvals";
import type { WorkItem } from "../shared/types";

// A complete one-pixel PNG; tests exercise stored bytes, not a mocked file hash.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
const details = { filename: "card.png", alt: "The selected card", source: { cardId: "source", contentRevision: "a".repeat(64) } };
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-image-test-"));
  roots.push(root);
  const store = new AttentionStore(path.join(root, "data"));
  await store.init();
  return { root, store, domain: new AttentionDomain(store, root) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("imports PNGs once under a content hash and refuses malformed, replaced, and symlinked bytes", async () => {
  const { root } = await setup();
  const image = await importCardImage(root, PNG, details);
  expect(await importCardImage(root, PNG, details)).toEqual(image);
  const filename = path.join(root, "artifacts", image.name);
  expect(await readFile(filename)).toEqual(PNG);
  await expect(importCardImage(root, Buffer.from("not an image"), details)).rejects.toThrow("PNG");
  await expect(importCardImage(root, PNG.subarray(0, -2), details)).rejects.toThrow("complete valid PNG");
  await chmod(filename, 0o644);
  await writeFile(filename, Buffer.from("tampered"));
  await expect(importCardImage(root, PNG, details)).rejects.toThrow("bytes changed");
  await expect(readCardImage(root, image.name)).rejects.toThrow("bytes changed");
  await rm(filename);
  const target = path.join(root, "actual.png");
  await writeFile(target, PNG);
  await symlink(target, filename);
  await expect(readCardImage(root, image.name)).rejects.toThrow();
});

test("binds the exact card revision, note and visible image into ordinary approval; checks bytes before send", async () => {
  const { root, domain, store } = await setup();
  await domain.bindFeed("company-attention", "image-test");
  const source = await domain.upsertCard("company-attention", { id: "source", title: "Concrete source", why: "A useful fact.", blocks: [] });
  await expect(domain.importImage("company-attention", source.id, "a".repeat(64), PNG, "card.png")).rejects.toThrow("Source card changed");
  const imageBlock = await domain.importImage("company-attention", source.id, readingContentRevision(source), PNG, "card.png");
  const card = await domain.upsertCard("company-attention", {
    id: "share", title: "Send the card", why: "Review the exact image and note.",
    blocks: [imageBlock, { id: "note", type: "editable_text", value: "This caught my eye." }],
    actions: [{ id: "send", label: "Send image", behavior: "approve_action", artifactBlockId: "note", instruction: "Send this image and note to the named recipient.", externalMutation: true }],
  });
  const approvedDigest = actionDigest(card, "send");
  for (const field of ["filename", "sha256"] as const) {
    const changed = structuredClone(card);
    changed.blocks[0].image![field] = field === "filename" ? "different.png" : "c".repeat(64);
    expect(actionDigest(changed, "send")).not.toBe(approvedDigest);
  }
  const revised = structuredClone(card);
  revised.blocks[0].image!.source.contentRevision = "b".repeat(64);
  expect(actionDigest(revised, "send")).not.toBe(approvedDigest);
  revised.blocks = revised.blocks.filter((block) => block.type !== "image");
  expect(actionDigest(revised, "send")).not.toBe(approvedDigest);
  const work = await domain.runCardAction("company-attention", card.id, "send");
  const claimed = await domain.claimWork("company-attention", "image-test") as WorkItem;
  const verified = await domain.verifyApprovedAction("company-attention", work.id, claimed.capabilityToken);
  expect(verified.attachments).toEqual([imageBlock]);
  expect(verified.artifact?.value).toBe("This caught my eye.");
  const file = path.join(root, "artifacts", imageBlock.image!.name);
  await rm(file);
  await expect(domain.verifyApprovedAction("company-attention", work.id, claimed.capabilityToken)).rejects.toThrow();
  await writeFile(file, PNG);
  await chmod(file, 0o644);
  await writeFile(file, Buffer.from("wrong bytes"));
  await expect(domain.verifyApprovedAction("company-attention", work.id, claimed.capabilityToken)).rejects.toThrow("bytes changed");
  await expect(verifyCardImages(root, [imageBlock])).rejects.toThrow("bytes changed");
  await writeFile(file, PNG);
  const current = await store.readCard("company-attention", card.id);
  current.blocks.find((block) => block.id === "note")!.value = "A different note.";
  await store.writeCard(current);
  await expect(domain.verifyApprovedAction("company-attention", work.id, claimed.capabilityToken)).rejects.toThrow("Approval stale");
});
