import { randomUUID } from "node:crypto";
import type { NativeApprovalQuestion, NativeApprovalSubmission, NativeApprovalView } from "../shared/nativeApproval";
import type { WorkItem } from "../shared/types";
import { formatWorkClaimOutput } from "./operator";
import type { AttentionStore } from "./store";
import { digest } from "./util";
import { configuredApprovalAction, requiredSourceMailbox } from "./workflow/approvals";

export interface NativeToolCall {
  id: string;
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
  arguments: unknown;
}

export interface NativeApprovalRequest {
  requestId: string | number;
  method: "item/tool/requestUserInput" | "tool/requestUserInput";
  tool: NativeToolCall;
  questions: NativeApprovalQuestion[];
}

interface PendingApproval {
  view: NativeApprovalView;
  threadId: string;
  workId: string;
  snapshotDigest: string;
  finish: (reply: unknown) => void;
}

export function nativeQuestions(params: Record<string, unknown>): NativeApprovalQuestion[] {
  if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 3) {
    throw new Error("Native confirmation must contain one to three questions.");
  }
  const questions = params.questions.map((question: any) => {
    if (!question || typeof question.id !== "string" || typeof question.question !== "string"
      || question.isSecret || !Array.isArray(question.options) || !question.options.length
      || question.options.length > 8) throw new Error("Unsupported native confirmation question.");
    const options = question.options.map((option: any) => {
      if (!option || typeof option.label !== "string" || typeof option.description !== "string") {
        throw new Error("Invalid native confirmation option.");
      }
      return { label: option.label, description: option.description };
    });
    if (new Set(options.map((option: { label: string }) => option.label)).size !== options.length) {
      throw new Error("Native confirmation options must be distinct.");
    }
    return { id: question.id, question: question.question, options };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("Native confirmation question ids must be distinct.");
  }
  return questions;
}

export class NativeApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly store: AttentionStore,
    private readonly notify: () => void = () => {},
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  async request(feedId: string, request: NativeApprovalRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return { answers: {} };
    const snapshot = await this.snapshot(feedId, request.tool.threadId);
    if (signal.aborted) return { answers: {} };
    const encoded = JSON.stringify(request);
    if (encoded.length > 100_000) throw new Error("Native request is too large to review in Tend.");
    const id = randomUUID();
    const view: NativeApprovalView = {
      id, feedId, cardId: snapshot.cardId, cardTitle: snapshot.cardTitle,
      actionLabel: snapshot.actionLabel, server: request.tool.server, tool: request.tool.tool,
      arguments: structuredClone(request.tool.arguments), questions: structuredClone(request.questions),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      requestDigest: digest({ id, request, snapshot: snapshot.digest }),
    };
    return new Promise((resolve) => {
      const finish = (reply: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.notify();
        resolve(reply);
      };
      const cancel = () => finish({ answers: {} });
      const timer = setTimeout(cancel, this.timeoutMs);
      this.pending.set(id, {
        view, threadId: request.tool.threadId, workId: snapshot.workId,
        snapshotDigest: snapshot.digest, finish,
      });
      signal.addEventListener("abort", cancel, { once: true });
      this.notify();
    });
  }

  async list(feedId: string): Promise<NativeApprovalView[]> {
    const views: NativeApprovalView[] = [];
    for (const pending of this.pending.values()) {
      if (pending.view.feedId !== feedId) continue;
      try {
        await this.assertCurrent(pending);
        if (this.pending.has(pending.view.id)) views.push(structuredClone(pending.view));
      } catch {
        pending.finish({ answers: {} });
      }
    }
    return views;
  }

  async respond(feedId: string, id: string, input: NativeApprovalSubmission): Promise<{ status: "responded" | "cancelled" }> {
    return this.store.serialize(async () => {
      const pending = this.pending.get(id);
      if (!pending || pending.view.feedId !== feedId) throw new Error("This confirmation is no longer pending.");
      if (input.requestDigest !== pending.view.requestDigest) throw new Error("The confirmation changed. Refresh before responding.");
      if (input.decision === "cancel") {
        pending.finish({ answers: {} });
        return { status: "cancelled" };
      }
      if (input.decision !== "respond") throw new Error("Choose a response or cancel the confirmation.");
      try {
        await this.assertCurrent(pending);
      } catch (error) {
        pending.finish({ answers: {} });
        throw error;
      }
      if (!this.pending.has(id)) throw new Error("This confirmation has already resolved.");
      const answers = input.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)
        || Object.keys(answers).length !== pending.view.questions.length) throw new Error("Answer every native confirmation question.");
      const reply: Record<string, { answers: string[] }> = Object.create(null);
      for (const question of pending.view.questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!question.options.some((option) => option.label === answer)) throw new Error("Select one of the host's exact options.");
        reply[question.id] = { answers: [answer!] };
      }
      await this.store.appendEvent({ feedId, cardId: pending.view.cardId, workId: pending.workId,
        type: "native_confirmation.response_recorded", detail: { requestId: id, requestDigest: pending.view.requestDigest,
          responseDigest: digest(reply), server: pending.view.server, tool: pending.view.tool } });
      if (!this.pending.has(id)) throw new Error("The host resolved this confirmation before the response could be sent.");
      pending.finish({ answers: reply });
      return { status: "responded" };
    });
  }

  close(): void {
    for (const pending of this.pending.values()) pending.finish({ answers: {} });
  }

  private async assertCurrent(pending: PendingApproval): Promise<void> {
    if (Date.now() >= Date.parse(pending.view.expiresAt)) throw new Error("This confirmation expired.");
    const current = await this.snapshot(pending.view.feedId, pending.threadId, pending.workId);
    if (current.digest !== pending.snapshotDigest) throw new Error("The card or approved action changed. Review the updated card.");
  }

  private async snapshot(feedId: string, threadId: string, workId?: string) {
    const feed = await this.store.readFeed(feedId);
    if (feed.thread.homeThreadId !== threadId) throw new Error("The native request does not belong to this feed's task.");
    const working = (await this.store.readWorkItems(feedId)).filter((work) => {
      const owner = (work as WorkItem & { claimedBy?: { agent: string; threadId: string } }).claimedBy;
      return work.status === "working" && work.approvalDigest
        && work.verifiedApprovalDigest === work.approvalDigest && work.verifiedAt
        && (!owner || (owner.agent === "codex" && owner.threadId === threadId));
    });
    if (working.length !== 1 || (workId && working[0].id !== workId)) throw new Error("Cannot bind this native request to one verified Tend action.");
    const work = working[0];
    const card = feed.cards.find((item) => item.id === work.cardId);
    if (work.completionCleanup && work.completionCleanup !== feed.config.defaultCleanup) {
      throw new Error("The approved completion cleanup changed. Verify a fresh approval first.");
    }
    if (card && work.kind === "execute_approved_action") {
      const mailbox = requiredSourceMailbox(feedId, card, configuredApprovalAction(card, work.cardActionId));
      if (mailbox && mailbox !== work.verifiedMailbox) throw new Error("The source mailbox changed after verification.");
    }
    const routineActionGroup = feed.routineActions.find((item) => item.id === work.routineActionGroupId);
    const output = formatWorkClaimOutput(feedId, work, { card, feedConfig: feed.config, routineActionGroup });
    const receipt = "operatorGuidance" in output ? output.operatorGuidance?.userAuthorization : undefined;
    if (!receipt) throw new Error("The approved action is stale or cannot be verified.");
    return {
      workId: work.id, cardId: work.cardId, cardTitle: card?.title ?? routineActionGroup?.label ?? receipt.actionLabel,
      actionLabel: receipt.actionLabel,
      digest: digest({ workId: work.id, receipt, verifiedAt: work.verifiedAt, verifiedMailbox: work.verifiedMailbox, card }),
    };
  }
}
