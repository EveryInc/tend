import XCTest
@testable import Tend

final class MobileModelTests: XCTestCase {
    func testCardIdentityIncludesFeed() {
        let inbox = FixtureData.cards.first { $0.feedId == "inbox" }!
        let company = MobileCard(
            key: "company-attention:\(inbox.cardId)",
            itemKind: inbox.itemKind,
            feedId: "company-attention",
            cardId: inbox.cardId,
            routineActionGroupId: inbox.routineActionGroupId,
            feedGeneration: inbox.feedGeneration,
            cardDigest: inbox.cardDigest,
            status: inbox.status,
            reviewPosition: inbox.reviewPosition,
            reviewable: inbox.reviewable,
            title: inbox.title,
            eyebrow: inbox.eyebrow,
            why: inbox.why,
            sourceMailbox: inbox.sourceMailbox,
            contextInfluence: inbox.contextInfluence,
            blocks: inbox.blocks,
            actions: inbox.actions,
            activeWork: inbox.activeWork,
            createdAt: inbox.createdAt,
            updatedAt: inbox.updatedAt,
            completedAt: inbox.completedAt
        )

        XCTAssertNotEqual(inbox.id, company.id)
        XCTAssertEqual(inbox.cardId, company.cardId)
    }

    func testDefaultArchiveRemainsVisibleAlongsideCustomActions() {
        let card = FixtureData.cards.first { $0.cardId == "cursor-reply" }!

        XCTAssertEqual(card.archiveAction?.label, "Archive")
        XCTAssertEqual(card.primaryAction?.label, "Send reply")
    }

    func testActivityStatesExplainOfflineAndStaleWork() {
        var pending = FixtureData.activities[0]
        pending.state = "pending"
        XCTAssertEqual(pending.displayState, "Waiting for Mac")

        var rejected = FixtureData.activities[0]
        rejected.state = "rejected"
        XCTAssertEqual(rejected.displayState, "Needs review")
    }

    func testFixtureContainsEveryCoreMobileSurface() {
        let snapshot = FixtureData.snapshot

        XCTAssertTrue(["inbox", "company-attention", "every"].allSatisfy { id in
            snapshot.feeds.contains { $0.id == id }
        })
        XCTAssertNotNil(snapshot.cards.first { $0.contextInfluence != nil })
        XCTAssertNotNil(snapshot.cards.first { !$0.editableBlocks.isEmpty })
        XCTAssertNotNil(snapshot.cards.first { card in card.blocks.contains { $0.chart != nil } })
        XCTAssertFalse(snapshot.mind.current?.observations.isEmpty ?? true)
    }

    @MainActor
    func testApprovalIncludesOnlyTheActionsExactArtifact() async throws {
        var card = FixtureData.cards.first { $0.cardId == "cursor-reply" }!
        card.blocks.append(
            MobileBlock(
                id: "unrelated-note",
                type: "editable_text",
                label: "Unrelated",
                title: nil,
                text: nil,
                value: "Do not submit this.",
                items: nil,
                before: nil,
                after: nil,
                editable: true,
                profile: nil,
                video: nil,
                chart: nil
            )
        )
        let action = try XCTUnwrap(card.actions.first { $0.artifactBlockId != nil })
        let repository = CapturingRepository()
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = TendAppModel(
            repository: repository,
            cache: MobileCache(directory: cacheDirectory),
            allowedEmail: "dan@every.to"
        )

        let succeeded = await model.submit(
            action: action,
            for: card,
            edits: [
                action.artifactBlockId!: "Approved exact draft.",
                "unrelated-note": "This must stay local.",
            ]
        )
        let submission = await repository.lastSubmission

        XCTAssertTrue(succeeded)
        XCTAssertEqual(submission?.edits, [action.artifactBlockId!: "Approved exact draft."])
        try? FileManager.default.removeItem(at: cacheDirectory)
    }

    @MainActor
    func testExpiredArchiveUndoDoesNotRestoreTheCardLocally() async throws {
        let card = try XCTUnwrap(FixtureData.cards.first { $0.cardId == "cursor-reply" })
        let activity = FixtureData.activities[0]
        let repository = CapturingRepository()
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = TendAppModel(
            repository: repository,
            cache: MobileCache(directory: cacheDirectory),
            allowedEmail: "dan@every.to"
        )
        var handled = card
        handled.reviewable = false
        handled.status = "queued"
        model.snapshot = MobileSnapshot(
            feeds: FixtureData.feeds,
            cards: [handled],
            mind: FixtureData.mind,
            activities: [activity],
            sync: FixtureData.snapshot.sync
        )
        model.pendingUndo = TendAppModel.UndoArchive(id: activity.id, card: card, activity: activity, kind: "archive")

        await model.undoArchive()

        XCTAssertNil(model.pendingUndo)
        XCTAssertFalse(try XCTUnwrap(model.snapshot.cards.first).reviewable)
        XCTAssertTrue(model.errorMessage?.contains("left the undo window") == true)
        try? FileManager.default.removeItem(at: cacheDirectory)
    }

    func testDismissAndArchiveAreDistinctControls() {
        let card = FixtureData.cards.first { $0.cardId == "agreements" }!

        XCTAssertEqual(card.archiveAction?.behavior, "default_cleanup")
        XCTAssertEqual(card.dismissAction?.behavior, "dismiss_card")
        XCTAssertNotEqual(card.archiveAction?.id, card.dismissAction?.id)
        XCTAssertNotEqual(card.primaryAction?.behavior, "dismiss_card")
    }

    @MainActor
    func testDismissCardSubmitsLocalDismissKindWithoutConnector() async throws {
        let card = try XCTUnwrap(FixtureData.cards.first { $0.cardId == "agreements" })
        let action = try XCTUnwrap(card.dismissAction)
        var cancelledActivity = FixtureData.activities[0]
        cancelledActivity.state = "cancelled"
        let repository = CapturingRepository(cancelResult: cancelledActivity)
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = TendAppModel(
            repository: repository,
            cache: MobileCache(directory: cacheDirectory),
            allowedEmail: "dan@every.to"
        )
        model.snapshot = FixtureData.snapshot
        let originalReviewCount = try XCTUnwrap(model.snapshot.feeds.first { $0.id == card.feedId }).reviewCount

        let succeeded = await model.submit(action: action, for: card, edits: [:])
        let submission = await repository.lastSubmission
        let queuedCard = try XCTUnwrap(model.snapshot.cards.first { $0.key == card.key })

        XCTAssertTrue(succeeded)
        XCTAssertEqual(submission?.kind, "dismiss")
        XCTAssertNil(submission?.riskConfirmation)
        XCTAssertNil(submission?.edits)
        XCTAssertFalse(queuedCard.reviewable)
        XCTAssertEqual(queuedCard.status, "queued")
        XCTAssertEqual(model.snapshot.feeds.first { $0.id == card.feedId }?.reviewCount, originalReviewCount - 1)
        XCTAssertEqual(model.pendingUndo?.kind, "dismiss")

        let pendingActivityID = try XCTUnwrap(model.pendingUndo?.activity.id)
        await model.undoArchive()

        let cancellationID = await repository.lastCancellationID
        XCTAssertEqual(cancellationID, pendingActivityID)
        let restoredCard = try XCTUnwrap(model.snapshot.cards.first { $0.key == card.key })
        XCTAssertTrue(restoredCard.reviewable)
        XCTAssertEqual(restoredCard.status, card.status)
        XCTAssertEqual(model.snapshot.feeds.first { $0.id == card.feedId }?.reviewCount, originalReviewCount)
        XCTAssertNil(model.pendingUndo)
        try? FileManager.default.removeItem(at: cacheDirectory)
    }

    @MainActor
    func testFixtureDismissIsWorkFreeAndSurvivesRefreshAndUndo() async throws {
        let repository = FixtureTendRepository()
        let initial = try await repository.loadSnapshot()
        let card = try XCTUnwrap(initial.cards.first { $0.cardId == "agreements" })
        let action = try XCTUnwrap(card.dismissAction)
        let cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = TendAppModel(
            repository: repository,
            cache: MobileCache(directory: cacheDirectory),
            allowedEmail: "dan@every.to"
        )
        model.snapshot = initial

        let succeeded = await model.submit(action: action, for: card, edits: [:])
        XCTAssertTrue(succeeded)
        let dismissedSnapshot = try await repository.loadSnapshot()
        let dismissed = try XCTUnwrap(dismissedSnapshot.cards.first { $0.key == card.key })
        let activity = try XCTUnwrap(dismissedSnapshot.activities.first)
        XCTAssertEqual(dismissed.status, "done")
        XCTAssertEqual(dismissed.completionDisposition, "dismissed")
        XCTAssertFalse(dismissed.reviewable)
        XCTAssertNil(activity.resultWorkId)
        XCTAssertNil(activity.workStatus)

        await model.undoArchive()
        let restoredSnapshot = try await repository.loadSnapshot()
        let restored = try XCTUnwrap(restoredSnapshot.cards.first { $0.key == card.key })
        XCTAssertEqual(restored.status, card.status)
        XCTAssertEqual(restored.reviewable, card.reviewable)
        XCTAssertEqual(restored.completionDisposition, card.completionDisposition)
        try? FileManager.default.removeItem(at: cacheDirectory)
    }

    func testMobileCardDecodesUnknownBehaviorAndOptionalDisposition() throws {
        let dismissedJSON = """
        {
          "key": "inbox:x", "itemKind": "attention", "feedId": "inbox", "cardId": "x",
          "feedGeneration": "pass:1", "cardDigest": "d", "status": "done", "reviewable": false,
          "title": "t", "eyebrow": "e", "why": "w", "blocks": [],
          "actions": [{"id": "a", "label": "L", "behavior": "totally_new", "digest": "d"}],
          "createdAt": "2026-07-13T00:00:00Z", "updatedAt": "2026-07-13T00:00:00Z",
          "completionDisposition": "dismissed"
        }
        """
        let dismissed = try JSONDecoder().decode(MobileCard.self, from: Data(dismissedJSON.utf8))
        XCTAssertEqual(dismissed.actions.first?.behavior, "totally_new")
        XCTAssertEqual(dismissed.completionDisposition, "dismissed")

        let legacyJSON = """
        {
          "key": "inbox:y", "itemKind": "attention", "feedId": "inbox", "cardId": "y",
          "feedGeneration": "pass:1", "cardDigest": "d", "status": "done", "reviewable": false,
          "title": "t", "eyebrow": "e", "why": "w", "blocks": [], "actions": [],
          "createdAt": "2026-07-13T00:00:00Z", "updatedAt": "2026-07-13T00:00:00Z"
        }
        """
        let legacy = try JSONDecoder().decode(MobileCard.self, from: Data(legacyJSON.utf8))
        XCTAssertNil(legacy.completionDisposition)
    }
}

private actor CapturingRepository: TendRepository {
    nonisolated let usesFixtures = true
    private(set) var lastSubmission: MobileCommandSubmission?
    private(set) var lastCancellationID: UUID?
    private let cancelResult: MobileActivity?

    init(cancelResult: MobileActivity? = nil) {
        self.cancelResult = cancelResult
    }

    func hasSession() async -> Bool { true }
    func requestSignInLink(email: String) async throws {}
    func handleAuthCallback(_ url: URL) async throws {}
    func signOut() async throws {}
    func loadSnapshot() async throws -> MobileSnapshot { FixtureData.snapshot }

    func submit(_ command: MobileCommandSubmission) async throws -> MobileActivity {
        lastSubmission = command
        return FixtureData.activities[0]
    }

    func cancel(commandID: UUID) async throws -> MobileActivity? {
        lastCancellationID = commandID
        return cancelResult
    }
    func startObserving(_ onChange: @escaping @Sendable () async -> Void) async throws {}
    func stopObserving() async {}
}
