import Foundation

actor FixtureTendRepository: TendRepository {
    nonisolated let usesFixtures = true

    private var snapshot = FixtureData.snapshot
    private var undoableCards: [UUID: MobileCard] = [:]

    func hasSession() async -> Bool { true }
    func requestSignInLink(email: String) async throws {}
    func handleAuthCallback(_ url: URL) async throws {}
    func signOut() async throws {}
    func loadSnapshot() async throws -> MobileSnapshot { snapshot }
    func startObserving(_ onChange: @escaping @Sendable () async -> Void) async throws {}
    func stopObserving() async {}

    func submit(_ command: MobileCommandSubmission) async throws -> MobileActivity {
        let now = Date().tendTimestamp
        let action = snapshot.cards
            .first(where: { $0.feedId == command.feedId && $0.cardId == command.cardId })?
            .actions
            .first(where: { $0.id == command.actionId })
        let payload = MobileActivityPayload(
            actionId: command.actionId,
            instruction: command.instruction ?? action?.label,
            riskConfirmation: command.riskConfirmation
        )
        let createsWork = command.kind != "dismiss"
        let activity = MobileActivity(
            id: command.id,
            feedId: command.feedId,
            cardId: command.cardId,
            kind: command.kind,
            payload: payload,
            state: "applied",
            availableAt: now,
            resultWorkId: createsWork ? "work-\(command.id.uuidString.lowercased())" : nil,
            workStatus: createsWork ? "queued" : nil,
            response: nil,
            error: nil,
            createdAt: now,
            updatedAt: now
        )
        if let index = snapshot.cards.firstIndex(where: { $0.feedId == command.feedId && $0.cardId == command.cardId }) {
            if command.kind == "archive" || command.kind == "dismiss" {
                undoableCards[command.id] = snapshot.cards[index]
            }
            snapshot.cards[index].reviewable = false
            snapshot.cards[index].status = command.kind == "dismiss" ? "done" : "queued"
            snapshot.cards[index].completionDisposition = command.kind == "dismiss" ? "dismissed" : nil
            if let feedIndex = snapshot.feeds.firstIndex(where: { $0.id == command.feedId }) {
                snapshot.feeds[feedIndex].reviewCount = max(0, snapshot.feeds[feedIndex].reviewCount - 1)
            }
        }
        snapshot.activities.insert(activity, at: 0)
        return activity
    }

    func cancel(commandID: UUID) async throws -> MobileActivity? {
        guard let activityIndex = snapshot.activities.firstIndex(where: { $0.id == commandID }) else {
            return nil
        }
        snapshot.activities[activityIndex].state = "cancelled"
        if let original = undoableCards.removeValue(forKey: commandID),
           let cardIndex = snapshot.cards.firstIndex(where: { $0.key == original.key }) {
            snapshot.cards[cardIndex] = original
            if let feedIndex = snapshot.feeds.firstIndex(where: { $0.id == original.feedId }) {
                snapshot.feeds[feedIndex].reviewCount += 1
            }
        }
        return snapshot.activities[activityIndex]
    }
}
