import type { VoiceTarget } from "../types";

export function sameTarget(left?: VoiceTarget | null, right?: VoiceTarget | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesTargetScope(left: VoiceTarget, right: VoiceTarget): boolean {
  if (left.kind === "sweep" && right.kind === "sweep") return left.feedId === right.feedId;
  return sameTarget(left, right);
}

function targetParents(target: VoiceTarget): VoiceTarget[] {
  if (target.kind === "card") return [{ kind: "sweep", feedId: target.feedId }, { kind: "feed", feedId: target.feedId }, { kind: "attention" }];
  if (target.kind === "sweep" || target.kind === "source_recipe" || target.kind === "prompt_layer") return [{ kind: "feed", feedId: target.feedId }, { kind: "attention" }];
  if (target.kind === "feed" || target.kind === "global_prompt") return [{ kind: "attention" }];
  return [];
}

export function closestTarget(target: VoiceTarget | null, ladder: VoiceTarget[]): VoiceTarget {
  if (!target) return ladder[0];
  for (const candidate of [target, ...targetParents(target)]) {
    const live = ladder.find((item) => matchesTargetScope(item, candidate));
    if (live) return live;
  }
  return ladder[ladder.length - 1];
}

export function preferredTarget(target: VoiceTarget | null, ladder: VoiceTarget[], explicitlyChanged: boolean): VoiceTarget {
  return explicitlyChanged ? closestTarget(target, ladder) : ladder[0];
}
