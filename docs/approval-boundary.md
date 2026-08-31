# Tend Approval And Connector Authorization

Status: recipient reporting is corrected; connector acceptance of a Tend click remains unimplemented.

## What Failed

An exact, later Tend click can pass `action:verify` and still be rejected by a connector that requires
authorization from its trusted user interface. Repeating the same call with more emphatic receipt
text does not provide new authorization. The approval digest verifies Tend's selected action and
artifact; it is not a connector-issued approval token.

`work:claim` returns the receipt as tool output. `server/codexAppServer.ts` submits the drain prompt
as ordinary `turn/start` text, and its request handler declines incoming server requests. Neither
path correlates a human Tend click with a pending connector approval request. The inspected Gmail
send tool accepts message fields but no Tend receipt or approval-token parameter.

Receipts therefore identify `scope: tend_workflow` and `connectorAuthorization: not_attested`.
The retained `noSecondChatConfirmationNeeded` field describes Tend's local decision only. It does
not waive a connector's own approval requirement or override a denial.

If the connector rejects the approval source, stop retries and preserve the work as blocked with
the exact reason. Present the required confirmation through the connector or host's trusted user
interface. After a later trusted confirmation, recheck source state, duplicates, and `action:verify`.
Reconcile an already successful blocked action using its authoritative receipt rather than sending
again. Do not change approval policies or use a different execution channel to route around a denial.

## Recipient Reporting

Recipient summaries use addresses named in the selected action and any leading outbound To/Cc/Bcc
header block in its editable draft. Folded headers are supported. Source-email blocks, body text,
signatures, quoted senders, and historical To/Cc headers do not become destinations. The exact full artifact remains bound to
the approval digest; this change does not remove quoted content from what the user approves.

The parser is a display and confirmation aid, not an email transport or authorization parser.
Operators must put the actual outbound destinations in the action instruction or leading envelope.
Unknown destinations must be resolved from authoritative context before execution, never inferred
from arbitrary addresses in the body. Conflicting action and envelope recipients require review.

## Host Integration Required

The [Codex App Server approval documentation](https://learn.chatgpt.com/docs/app-server#approvals)
describes server-initiated approval requests and client responses. App tool calls may require user
input, and MCP elicitation requests carry a request identity and expected response shape. These
flows are distinct from embedding a receipt in prompt text. The inspected protocol and documentation
do not establish a way to attest an arbitrary Tend click to Gmail's authorization reviewer.

To deliver one approval click, the host must expose a trusted approval request that Tend can display
and answer for the exact operation. Required contract:

1. The host creates a pending operation with request, thread, turn, tool, and authenticated account
   identity, plus exact To/Cc/Bcc, reply/source identity, subject, body, attachments, and content digest.
2. Tend displays that operation and binds the human click to the host's request identity. Background
   work, source content, receipt prose, and agents cannot mint an equivalent approval.
3. The host consumes the correlated response once. Any changed content, recipient, mailbox, source
   context, expiration, or consumed request rejects the response and requests fresh review.
4. Tend records connector acceptance and an authoritative result separately from its local approval.
   A timeout requires outcome reconciliation before any retry.

This requires a supported host contract and a connector integration test. It is not implemented by
this change. Do not auto-answer arbitrary user-input or MCP requests, invent provenance metadata,
or treat host attestation for another purpose as proof of user consent.

Validation must show an actual host approval accepted once, text-only and forged receipts rejected,
changed snapshots rejected, and interrupted operations reconciled without duplicate sends. Local
digest tests alone cannot demonstrate connector acceptance.
