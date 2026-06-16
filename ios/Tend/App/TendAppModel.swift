import Foundation
import Observation

@MainActor
@Observable
final class TendAppModel {
    enum AuthState: Equatable {
        case loading
        case signedOut
        case linkSent
        case authenticated
    }

    struct UndoArchive: Identifiable {
        let id: UUID
        let card: MobileCard
        let activity: MobileActivity
    }

    var authState: AuthState = .loading
    var snapshot: MobileSnapshot = .empty
    var selectedTab = 0
    var selectedFeedID: String?
    var email: String
    var isRefreshing = false
    var isSubmitting = false
    var errorMessage: String?
    var drafts: [String: String] = [:]
    var pendingUndo: UndoArchive?

    let usesFixtures: Bool
    private let repository: any TendRepository
    private let cache: MobileCache
    private let allowedEmail: String
    private var undoTask: Task<Void, Never>?
    private var hasStarted = false
    private var refreshAgain = false

    static func make(configuration: TendConfiguration = .load()) -> TendAppModel {
        let repository: any TendRepository
        if configuration.usesFixtures {
            repository = FixtureTendRepository()
        } else if let live = try? SupabaseTendRepository(configuration: configuration) {
            repository = live
        } else {
            repository = FixtureTendRepository()
        }
        return TendAppModel(
            repository: repository,
            cache: MobileCache(),
            allowedEmail: configuration.allowedEmail
        )
    }

    init(repository: any TendRepository, cache: MobileCache, allowedEmail: String) {
        self.repository = repository
        self.cache = cache
        self.allowedEmail = allowedEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.email = self.allowedEmail
        self.usesFixtures = repository.usesFixtures
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        if !repository.usesFixtures {
            if let cached = await cache.loadSnapshot() {
                snapshot = cached
                selectedFeedID = preferredFeedID(in: cached)
            }
            drafts = await cache.loadDrafts()
        }
        let hasSession = repository.usesFixtures ? true : await repository.hasSession()
        if hasSession {
            await finishAuthentication()
        } else {
            snapshot = .empty
            drafts = [:]
            selectedFeedID = nil
            await cache.clear()
            authState = .signedOut
        }
    }

    func requestSignInLink() async {
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            errorMessage = "Enter the email address allowed to use Tend."
            return
        }
        guard allowedEmail.isEmpty || normalized == allowedEmail else {
            errorMessage = "This Tend build is configured for \(allowedEmail)."
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await repository.requestSignInLink(email: normalized)
            email = normalized
            authState = .linkSent
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func handleAuthCallback(_ url: URL) async {
        guard !repository.usesFixtures else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await repository.handleAuthCallback(url)
            await finishAuthentication()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        do {
            await repository.stopObserving()
            try await repository.signOut()
            undoTask?.cancel()
            pendingUndo = nil
            snapshot = .empty
            drafts = [:]
            selectedFeedID = nil
            await cache.clear()
            authState = .signedOut
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard authState == .authenticated else { return }
        if isRefreshing {
            refreshAgain = true
            return
        }
        repeat {
            refreshAgain = false
            isRefreshing = true
            do {
                let next = try await repository.loadSnapshot()
                snapshot = next
                selectedFeedID = selectedFeedID.flatMap { id in next.feeds.contains(where: { $0.id == id }) ? id : nil }
                    ?? preferredFeedID(in: next)
                await cache.save(snapshot: next)
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
            isRefreshing = false
        } while refreshAgain && authState == .authenticated
    }

    func cards(for feedID: String) -> [MobileCard] {
        snapshot.cards
            .filter { $0.feedId == feedID && $0.reviewable }
            .sorted {
                ($0.reviewPosition ?? .max, $0.updatedAt) < ($1.reviewPosition ?? .max, $1.updatedAt)
            }
    }

    func feed(for id: String) -> MobileFeed? {
        snapshot.feeds.first(where: { $0.id == id })
    }

    func submitInstruction(for card: MobileCard, text: String) async -> Bool {
        let instruction = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return false }
        let submission = baseCommand(for: card, kind: "instruction", instruction: instruction)
        let succeeded = await submit(submission, card: card)
        if succeeded {
            drafts[card.key] = ""
            await cache.save(drafts: drafts)
        }
        return succeeded
    }

    func submit(action: MobileAction, for card: MobileCard, edits: [String: String]) async -> Bool {
        let kind: String
        if action.behavior == "default_cleanup" {
            kind = "archive"
        } else if card.itemKind == "routine_action_group" {
            kind = "approve_routine_action"
        } else if action.behavior == "queue_instruction" {
            kind = "instruction"
        } else {
            kind = "approve_action"
        }
        let approvedEdits = action.artifactBlockId.flatMap { blockID in
            edits[blockID].map { [blockID: $0] }
        }
        let submission = MobileCommandSubmission(
            id: UUID(),
            clientRequestId: UUID(),
            deviceId: DeviceIdentity.value(),
            feedId: card.feedId,
            cardId: card.cardId,
            feedGeneration: card.feedGeneration,
            expectedCardDigest: card.cardDigest,
            kind: kind,
            actionId: action.id,
            expectedActionDigest: action.digest,
            routineActionGroupId: card.routineActionGroupId,
            instruction: nil,
            edits: approvedEdits,
            targetWorkId: nil,
            expectedWorkDigest: nil,
            riskConfirmation: action.confirmation.map {
                RiskConfirmationSubmission(kind: $0.kind, recipients: $0.recipients)
            }
        )
        return await submit(submission, card: card)
    }

    func editQueuedNote(for card: MobileCard, instruction: String) async -> Bool {
        guard let work = card.activeWork else { return false }
        let submission = MobileCommandSubmission(
            id: UUID(),
            clientRequestId: UUID(),
            deviceId: DeviceIdentity.value(),
            feedId: card.feedId,
            cardId: card.cardId,
            feedGeneration: card.feedGeneration,
            expectedCardDigest: card.cardDigest,
            kind: "edit_queued_instruction",
            actionId: nil,
            expectedActionDigest: nil,
            routineActionGroupId: nil,
            instruction: instruction,
            edits: nil,
            targetWorkId: work.id,
            expectedWorkDigest: work.digest,
            riskConfirmation: nil
        )
        return await submit(submission, card: card, removeFromReview: false)
    }

    func returnToReview(_ card: MobileCard) async -> Bool {
        let submission = baseCommand(for: card, kind: "return_to_review", instruction: nil)
        return await submit(submission, card: card, removeFromReview: false)
    }

    func undoArchive() async {
        guard let undo = pendingUndo else { return }
        undoTask?.cancel()
        do {
            guard let cancelled = try await repository.cancel(commandID: undo.activity.id) else {
                pendingUndo = nil
                await refresh()
                errorMessage = "That archive already left the undo window. Its current state is shown in Activity."
                return
            }
            restore(card: undo.card)
            if let index = snapshot.activities.firstIndex(where: { $0.id == undo.activity.id }) {
                snapshot.activities[index] = cancelled
            }
            pendingUndo = nil
            await cache.save(snapshot: snapshot)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateDraft(_ value: String, for card: MobileCard) {
        drafts[card.key] = value
        Task { await cache.save(drafts: drafts) }
    }

    func activityCard(_ activity: MobileActivity) -> MobileCard? {
        snapshot.cards.first { $0.feedId == activity.feedId && $0.cardId == activity.cardId }
    }

    private func baseCommand(for card: MobileCard, kind: String, instruction: String?) -> MobileCommandSubmission {
        MobileCommandSubmission(
            id: UUID(),
            clientRequestId: UUID(),
            deviceId: DeviceIdentity.value(),
            feedId: card.feedId,
            cardId: card.cardId,
            feedGeneration: card.feedGeneration,
            expectedCardDigest: card.cardDigest,
            kind: kind,
            actionId: nil,
            expectedActionDigest: nil,
            routineActionGroupId: card.routineActionGroupId,
            instruction: instruction,
            edits: nil,
            targetWorkId: nil,
            expectedWorkDigest: nil,
            riskConfirmation: nil
        )
    }

    private func submit(
        _ submission: MobileCommandSubmission,
        card: MobileCard,
        removeFromReview: Bool = true
    ) async -> Bool {
        guard !isSubmitting else { return false }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let activity = try await repository.submit(submission)
            upsert(activity: activity)
            if removeFromReview {
                markHandled(card: card)
            }
            if submission.kind == "archive" {
                pendingUndo = UndoArchive(id: activity.id, card: card, activity: activity)
                undoTask?.cancel()
                undoTask = Task {
                    try? await Task.sleep(for: .seconds(5))
                    if !Task.isCancelled, pendingUndo?.id == activity.id {
                        pendingUndo = nil
                    }
                }
            }
            await cache.save(snapshot: snapshot)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func upsert(activity: MobileActivity) {
        snapshot.activities.removeAll { $0.id == activity.id }
        snapshot.activities.insert(activity, at: 0)
    }

    private func markHandled(card: MobileCard) {
        if let index = snapshot.cards.firstIndex(where: { $0.key == card.key }) {
            snapshot.cards[index].reviewable = false
            snapshot.cards[index].status = "queued"
        }
        if let feedIndex = snapshot.feeds.firstIndex(where: { $0.id == card.feedId }) {
            snapshot.feeds[feedIndex].reviewCount = max(0, snapshot.feeds[feedIndex].reviewCount - 1)
        }
    }

    private func restore(card: MobileCard) {
        if let index = snapshot.cards.firstIndex(where: { $0.key == card.key }) {
            snapshot.cards[index] = card
        } else {
            snapshot.cards.append(card)
        }
        if let feedIndex = snapshot.feeds.firstIndex(where: { $0.id == card.feedId }) {
            snapshot.feeds[feedIndex].reviewCount += 1
        }
    }

    private func preferredFeedID(in snapshot: MobileSnapshot) -> String? {
        snapshot.feeds
            .sorted { left, right in
                if (left.reviewCount > 0) != (right.reviewCount > 0) {
                    return left.reviewCount > 0
                }
                return left.position < right.position
            }
            .first?
            .id
    }

    private func finishAuthentication() async {
        authState = .authenticated
        errorMessage = nil
        await refresh()
        try? await repository.startObserving { [weak self] in
            await self?.refresh()
        }
    }
}
