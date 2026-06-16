import Foundation

actor FixtureTendRepository: TendRepository {
    nonisolated let usesFixtures = true

    private var snapshot = FixtureData.snapshot
    private var archivedCards: [UUID: MobileCard] = [:]

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
        let activity = MobileActivity(
            id: command.id,
            feedId: command.feedId,
            cardId: command.cardId,
            kind: command.kind,
            payload: payload,
            state: "applied",
            availableAt: now,
            resultWorkId: "work-\(command.id.uuidString.lowercased())",
            workStatus: "queued",
            response: nil,
            error: nil,
            createdAt: now,
            updatedAt: now
        )
        if let index = snapshot.cards.firstIndex(where: { $0.feedId == command.feedId && $0.cardId == command.cardId }) {
            if command.kind == "archive" {
                archivedCards[command.id] = snapshot.cards[index]
            }
            snapshot.cards[index].reviewable = false
            snapshot.cards[index].status = "queued"
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
        if let archived = archivedCards.removeValue(forKey: commandID),
           let cardIndex = snapshot.cards.firstIndex(where: { $0.key == archived.key }) {
            snapshot.cards[cardIndex] = archived
            if let feedIndex = snapshot.feeds.firstIndex(where: { $0.id == archived.feedId }) {
                snapshot.feeds[feedIndex].reviewCount += 1
            }
        }
        return snapshot.activities[activityIndex]
    }
}
