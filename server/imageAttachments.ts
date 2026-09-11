import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { CardBlock, CardImage } from "../shared/types";

export const MAX_CARD_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const IMAGE_NAME = /^card-image-([a-f0-9]{64})\.png$/;

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > MAX_CARD_IMAGE_BYTES || bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Card images must be PNG files up to 20 MB.");
  }
  let cursor = 8;
  let hasData = false;
  let width = 0;
  let height = 0;
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const end = cursor + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", cursor + 4, cursor + 8);
    if (cursor === 8) {
      if (type !== "IHDR" || length !== 13) break;
      width = bytes.readUInt32BE(cursor + 8);
      height = bytes.readUInt32BE(cursor + 12);
      if (!width || !height || width > 16000 || height > 16000) break;
    } else if (type === "IHDR") break;
    // Validate chunk checksums so truncated or corrupted imports never become previews.
    let crc = 0xffffffff;
    for (let index = cursor + 4; index < end - 4; index++) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) break;
    if (type === "IDAT") hasData = true;
    if (type === "IEND") {
      if (length === 0 && end === bytes.length && hasData) return { width, height };
      break;
    }
    cursor = end;
  }
  throw new Error("Card image is not a complete valid PNG.");
}

export function validateCardImage(image: unknown): asserts image is CardImage {
  const value = image as CardImage | undefined;
  if (!value || typeof value !== "object" || typeof value.sha256 !== "string" ||
    value.name !== `card-image-${value.sha256}.png` || !IMAGE_NAME.test(value.name) ||
    value.mediaType !== "image/png" || !Number.isInteger(value.byteLength) || value.byteLength < 57 || value.byteLength > MAX_CARD_IMAGE_BYTES ||
    !Number.isInteger(value.width) || value.width < 1 || value.width > 16000 ||
    !Number.isInteger(value.height) || value.height < 1 || value.height > 16000 ||
    typeof value.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.png$/.test(value.filename) ||
    typeof value.alt !== "string" || !value.alt.trim() || value.alt.length > 1000 ||
    !value.source || typeof value.source.cardId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(value.source.cardId) ||
    typeof value.source.contentRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.source.contentRevision)) {
    throw new Error("Image blocks require an imported PNG descriptor and exact source card revision.");
  }
}

export async function readCardImage(artifactsDir: string, name: string): Promise<Buffer> {
  const match = IMAGE_NAME.exec(name);
  if (!match) throw new Error("Invalid card image name.");
  const file = await open(path.join(artifactsDir, "artifacts", name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CARD_IMAGE_BYTES) throw new Error("Card image is not a regular PNG file.");
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== match[1]) throw new Error("Card image bytes changed. Reimport and review the image before sending.");
    return bytes;
  } finally { await file.close(); }
}

export async function importCardImage(artifactsDir: string, bytes: Buffer, details: Pick<CardImage, "filename" | "alt" | "source">): Promise<CardImage> {
  const dimensions = pngDimensions(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const image: CardImage = { ...details, ...dimensions, sha256, name: `card-image-${sha256}.png`, mediaType: "image/png", byteLength: bytes.length };
  validateCardImage(image);
  const directory = path.join(artifactsDir, "artifacts");
  await mkdir(directory, { recursive: true });
  try {
    const file = await open(path.join(directory, image.name), "wx", 0o444);
    try { await file.writeFile(bytes); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await verifyCardImages(artifactsDir, [{ id: "image", type: "image", image }]);
  return image;
}

export async function verifyCardImages(artifactsDir: string, blocks: CardBlock[]): Promise<CardBlock[]> {
  const images = blocks.filter((block) => block.type === "image");
  for (const block of images) {
    validateCardImage(block.image);
    const bytes = await readCardImage(artifactsDir, block.image.name);
    const dimensions = pngDimensions(bytes);
    if (bytes.length !== block.image.byteLength || dimensions.width !== block.image.width || dimensions.height !== block.image.height) {
      throw new Error("Card image metadata does not match its saved bytes.");
    }
  }
  return images;
}
