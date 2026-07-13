import { containsFullEmail } from "../shared/emailThread";
import type { CardAction, CardBlock } from "../shared/types";
import { safeIdentifier } from "./util";

const CARD_BLOCK_TYPES = new Set<CardBlock["type"]>([
  "rich_text",
  "evidence",
  "editable_text",
  "memo",
  "options",
  "checklist",
  "diff",
  "clarification",
  "email_thread",
  "profile",
  "video",
  "chart",
  "receipt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isSafeCardHref(value: string): boolean {
  if (value.startsWith("/api/artifacts/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function blockDescription(block: Record<string, unknown>, index: number): string {
  const type = typeof block.type === "string" ? block.type : "unknown type";
  const id = typeof block.id === "string" && block.id.trim() ? ` "${block.id}"` : "";
  return `Card block ${index + 1} (${type}${id})`;
}

function validateTextBlock(block: Record<string, unknown>, index: number, hint?: string): void {
  if (hasText(block.text)) return;
  throw new Error(`${blockDescription(block, index)} needs a non-empty \`text\` string.${hint ? ` ${hint}` : ""}`);
}

function validateListBlock(block: Record<string, unknown>, index: number): void {
  if (!Array.isArray(block.items) || !block.items.length) {
    throw new Error(`${blockDescription(block, index)} needs a non-empty \`items\` array.`);
  }
  for (const [itemIndex, item] of block.items.entries()) {
    if (hasText(item)) continue;
    if (!isRecord(item) || !hasText(item.label)) {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} must be a non-empty string or an object with a non-empty \`label\`.`);
    }
    if (item.detail !== undefined && typeof item.detail !== "string") {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} has a non-string \`detail\`.`);
    }
    if (item.checked !== undefined && typeof item.checked !== "boolean") {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} has a non-boolean \`checked\`.`);
    }
    if (item.href !== undefined) {
      if (block.type !== "evidence") {
        throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} may use \`href\` only in an evidence block.`);
      }
      if (!hasText(item.href) || !isSafeCardHref(item.href)) {
        throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} needs an http(s) or local artifact \`href\`.`);
      }
    }
  }
}

export function validateCardBlocks(blocks: unknown): asserts blocks is CardBlock[] {
  if (!Array.isArray(blocks)) throw new Error("Card blocks must be an array.");
  const ids = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block)) throw new Error(`Card block ${index + 1} must be an object.`);
    if (!hasText(block.id)) throw new Error(`${blockDescription(block, index)} needs a non-empty \`id\` string.`);
    if (ids.has(block.id)) throw new Error(`${blockDescription(block, index)} repeats block id "${block.id}". Block ids must be unique within a card.`);
    ids.add(block.id);
    if (typeof block.type !== "string" || !CARD_BLOCK_TYPES.has(block.type as CardBlock["type"])) {
      throw new Error(`${blockDescription(block, index)} has an unsupported \`type\`.`);
    }
    if (block.label !== undefined && typeof block.label !== "string") {
      throw new Error(`${blockDescription(block, index)} has a non-string \`label\`.`);
    }
    if (block.type !== "email_thread" && block.sourceSnapshot !== undefined) {
      throw new Error(`${blockDescription(block, index)} may use \`sourceSnapshot\` only for an email_thread block.`);
    }
    switch (block.type) {
      case "memo":
        validateTextBlock(block, index, "Use `text`, not `title` or `body`.");
        break;
      case "receipt":
        validateTextBlock(block, index, "Put source links in `text` using Markdown link syntax, not a loose `url` field.");
        break;
      case "rich_text":
      case "clarification":
        validateTextBlock(block, index);
        break;
      case "email_thread": {
        const hasReference = block.sourceSnapshot !== undefined;
        const hasInlineText = block.text !== undefined;
        if (hasReference === hasInlineText) {
          throw new Error(`${blockDescription(block, index)} needs exactly one of full \`text\` or \`sourceSnapshot\`.`);
        }
        if (hasReference) {
          if (
            !isRecord(block.sourceSnapshot)
            || !hasText(block.sourceSnapshot.runId)
            || !hasText(block.sourceSnapshot.sourceId)
            || !hasText(block.sourceSnapshot.snapshotId)
          ) {
            throw new Error(`${blockDescription(block, index)} has an invalid source snapshot reference.`);
          }
          break;
        }
        validateTextBlock(block, index);
        if (typeof block.text !== "string" || !containsFullEmail(block.text)) {
          throw new Error(
            `${blockDescription(block, index)} must contain the full source email with From, To, and Subject headers. Use a memo block for summaries.`,
          );
        }
        break;
      }
      case "evidence":
      case "options":
      case "checklist":
        validateListBlock(block, index);
        break;
      case "editable_text":
        if (typeof block.value !== "string") throw new Error(`${blockDescription(block, index)} needs a string \`value\`.`);
        break;
      case "diff":
        if (typeof block.before !== "string" || typeof block.after !== "string") {
          throw new Error(`${blockDescription(block, index)} needs string \`before\` and \`after\` values.`);
        }
        break;
      case "profile":
        if (
          !isRecord(block.profile)
          || !hasText(block.profile.name)
          || !hasText(block.profile.href)
          || !hasText(block.profile.imageUrl)
        ) {
          throw new Error(`${blockDescription(block, index)} needs \`profile.name\`, \`profile.href\`, and \`profile.imageUrl\` strings.`);
        }
        if (block.profile.links !== undefined) {
          if (!Array.isArray(block.profile.links) || block.profile.links.some((link) => !isRecord(link) || !hasText(link.label) || !hasText(link.href))) {
            throw new Error(`${blockDescription(block, index)} profile links need non-empty \`label\` and \`href\` strings.`);
          }
        }
        break;
      case "video":
        if (!isRecord(block.video) || !hasText(block.video.title) || !hasText(block.video.href)) {
          throw new Error(`${blockDescription(block, index)} needs \`video.title\` and \`video.href\` strings.`);
        }
        break;
      case "chart": {
        if (!isRecord(block.chart) || typeof block.chart.max !== "number" || !Number.isFinite(block.chart.max) || block.chart.max <= 0) {
          throw new Error(`${blockDescription(block, index)} needs a positive numeric \`chart.max\`.`);
        }
        const max = block.chart.max;
        if (
          !Array.isArray(block.chart.series)
          || block.chart.series.length !== 2
          || block.chart.series.some((series) => !isRecord(series) || !hasText(series.label))
        ) {
          throw new Error(`${blockDescription(block, index)} needs exactly two \`chart.series\` entries with non-empty \`label\` strings.`);
        }
        if (!Array.isArray(block.chart.rows) || !block.chart.rows.length) {
          throw new Error(`${blockDescription(block, index)} needs a non-empty \`chart.rows\` array.`);
        }
        for (const [rowIndex, row] of block.chart.rows.entries()) {
          if (
            !isRecord(row)
            || !hasText(row.label)
            || !Array.isArray(row.values)
            || row.values.length !== 2
            || row.values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
          ) {
            throw new Error(`${blockDescription(block, index)} chart row ${rowIndex + 1} needs a non-empty \`label\` and exactly two numeric \`values\` between 0 and \`chart.max\`.`);
          }
          if (row.detail !== undefined && typeof row.detail !== "string") {
            throw new Error(`${blockDescription(block, index)} chart row ${rowIndex + 1} has a non-string \`detail\`.`);
          }
        }
        if (block.chart.unit !== undefined && typeof block.chart.unit !== "string") {
          throw new Error(`${blockDescription(block, index)} has a non-string \`chart.unit\`.`);
        }
        if (block.chart.note !== undefined && typeof block.chart.note !== "string") {
          throw new Error(`${blockDescription(block, index)} has a non-string \`chart.note\`.`);
        }
        break;
      }
    }
  }
}

export function validateCardActions(actions: unknown): asserts actions is CardAction[] | undefined {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) throw new Error("Card actions must be an array.");
  const ids = new Set<string>();
  const shortcuts = new Set<string>();
  for (const [index, action] of actions.entries()) {
    if (!isRecord(action)) throw new Error(`Card action ${index + 1} must be an object.`);
    if (typeof action.id !== "string") throw new Error(`Card action ${index + 1} id is required.`);
    const id = safeIdentifier(action.id, `Card action ${index + 1} id`);
    if (id === "proposed-action" || id === "default-cleanup") throw new Error(`Card action id ${id} is reserved by Tend.`);
    if (ids.has(id)) throw new Error(`Card action id is duplicated: ${id}`);
    ids.add(id);
    if (!hasText(action.label)) throw new Error(`Card action ${id} label is required.`);
    if (action.behavior !== "queue_instruction" && action.behavior !== "approve_action" && action.behavior !== "default_cleanup") {
      throw new Error(`Card action ${id} has an invalid behavior.`);
    }
    if (action.behavior !== "default_cleanup" && !hasText(action.instruction)) {
      throw new Error(`Card action ${id} instruction is required.`);
    }
    if (action.instruction !== undefined && !hasText(action.instruction)) throw new Error(`Card action ${id} has an invalid instruction.`);
    if (action.artifactBlockId !== undefined && !hasText(action.artifactBlockId)) throw new Error(`Card action ${id} has an invalid artifactBlockId.`);
    if (action.externalMutation !== undefined && typeof action.externalMutation !== "boolean") throw new Error(`Card action ${id} has an invalid externalMutation flag.`);
    if (action.mailboxPolicy !== undefined && action.mailboxPolicy !== "reply_from_source") throw new Error(`Card action ${id} has an invalid mailboxPolicy.`);
    if (action.variant !== undefined && action.variant !== "primary" && action.variant !== "secondary") throw new Error(`Card action ${id} has an invalid variant.`);
    if (action.shortcut !== undefined) {
      if (typeof action.shortcut !== "string" || !action.shortcut.trim()) throw new Error(`Card action ${id} shortcut is required.`);
      const shortcut = action.shortcut.trim().toLowerCase();
      if (shortcuts.has(shortcut)) throw new Error(`Card action shortcut is duplicated: ${shortcut}`);
      shortcuts.add(shortcut);
    }
  }
}
