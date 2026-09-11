export interface NativeApprovalQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

export interface NativeApprovalView {
  id: string;
  feedId: string;
  cardId: string;
  cardTitle: string;
  actionLabel: string;
  server: string;
  tool: string;
  arguments: unknown;
  questions: NativeApprovalQuestion[];
  expiresAt: string;
  requestDigest: string;
}

export interface NativeApprovalSubmission {
  requestDigest: string;
  decision: "respond" | "cancel";
  answers?: Record<string, string>;
}
