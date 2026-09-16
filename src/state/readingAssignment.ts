import type { ReadingPresentationAssignment } from "../../shared/types";
import { readingProgressMember, type ReadingCardGroup } from "../../shared/readingGroups";

export const READING_ASSIGNMENT_STORAGE = "attention.readingAssignments.v1";
export type ReadingAssignments = Record<string, Record<string, ReadingPresentationAssignment>>;

export function readReadingAssignments(): ReadingAssignments {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(READING_ASSIGNMENT_STORAGE) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).flatMap(([feedId, groups]) => {
      if (!groups || typeof groups !== "object" || Array.isArray(groups)) return [];
      return [[feedId, Object.fromEntries(Object.entries(groups).flatMap(([groupId, assignment]) => validReadingAssignment(assignment) ? [[groupId, assignment] as const] : []))]];
    }));
  } catch { return {}; }
}

function validReadingAssignment(value: unknown): value is ReadingPresentationAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const saved = value as ReadingPresentationAssignment;
  return typeof saved.id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(saved.id)
    && typeof saved.groupId === "string" && saved.groupId.length > 0 && saved.groupId.length <= 1000
    && typeof saved.firstCardId === "string" && saved.firstCardId.length > 0
    && ["randomized_pair", "single_available", "restored_selection", "preferred", "previously_reviewed"].includes(saved.reason)
    && Array.isArray(saved.members) && saved.members.length > 0 && saved.members.length <= 64
    && saved.members.every((member) => member && typeof member === "object" && typeof member.cardId === "string"
      && member.cardId.length > 0 && typeof member.contentRevision === "string" && /^[a-f0-9]{64}$/.test(member.contentRevision))
    && new Set(saved.members.map((member) => member.cardId)).size === saved.members.length
    && saved.members.some((member) => member.cardId === saved.firstCardId)
    && (saved.reason !== "randomized_pair" || saved.members.length === 2);
}

export function writeReadingAssignments(assignments: ReadingAssignments) {
  try { localStorage.setItem(READING_ASSIGNMENT_STORAGE, JSON.stringify(assignments)); } catch { /* Reading works with storage blocked. */ }
}

export function assignmentMembers(group: ReadingCardGroup) {
  return group.cards.flatMap((card) => { const member = readingProgressMember(card); return member ? [member] : []; });
}

/** A late alternate can join a seen singleton, but must never change its first assignment. */
export function usableReadingAssignment(group: ReadingCardGroup, saved?: ReadingPresentationAssignment): saved is ReadingPresentationAssignment {
  if (!validReadingAssignment(saved) || saved.groupId !== group.id) return false;
  const members = assignmentMembers(group);
  return saved.members.some((member) => member.cardId === saved.firstCardId)
    && saved.members.every((member) => members.some((current) => current.cardId === member.cardId && current.contentRevision === member.contentRevision));
}

export function createReadingAssignment(group: ReadingCardGroup, options: {
  selectedId?: string; preferredId?: string | null; previouslyReviewed?: boolean; random?: () => number; id?: string;
} = {}): ReadingPresentationAssignment {
  const selected = group.cards.find((card) => card.id === options.selectedId);
  const preferred = group.cards.find((card) => card.id === options.preferredId);
  const reason = selected ? "restored_selection" : preferred ? "preferred" : options.previouslyReviewed ? "previously_reviewed"
    : group.cards.length === 2 ? "randomized_pair" : "single_available";
  const randomIndex = reason === "randomized_pair" ? Math.floor(Math.min(0.999999999, Math.max(0, (options.random ?? Math.random)())) * 2) : 0;
  return { id: options.id ?? crypto.randomUUID(), groupId: group.id, members: assignmentMembers(group),
    firstCardId: (selected ?? preferred ?? group.cards[randomIndex]).id, reason };
}

/** Version numbers describe this reader's presentation order, preserving the underlying card IDs. */
export function orderAssignedGroup<T extends ReadingCardGroup>(group: T, assignment: ReadingPresentationAssignment): T {
  const first = group.cards.find((card) => card.id === assignment.firstCardId);
  return first ? { ...group, cards: [first, ...group.cards.filter((card) => card.id !== first.id)] } : group;
}
