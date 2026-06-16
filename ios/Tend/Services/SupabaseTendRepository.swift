import Foundation
import Supabase

actor SupabaseTendRepository: TendRepository {
    nonisolated let usesFixtures = false

    private static let authCallbackURL = URL(string: "to.every.tend://auth-callback")!

    private let client: SupabaseClient
    private var channel: RealtimeChannelV2?
    private var observationTasks: [Task<Void, Never>] = []

    init(configuration: TendConfiguration) throws {
        guard let url = configuration.supabaseURL, !configuration.publishableKey.isEmpty else {
            throw TendRepositoryError.invalidConfiguration
        }
        client = SupabaseClient(
            supabaseURL: url,
            supabaseKey: configuration.publishableKey,
            options: SupabaseClientOptions(
                auth: .init(storage: KeychainLocalStorage())
            )
        )
    }

    func hasSession() async -> Bool {
        (try? await client.auth.session) != nil
    }

    func requestSignInLink(email: String) async throws {
        try await client.auth.signInWithOTP(
            email: email,
            redirectTo: Self.authCallbackURL,
            shouldCreateUser: false
        )
    }

    func handleAuthCallback(_ url: URL) async throws {
        guard url.scheme?.lowercased() == Self.authCallbackURL.scheme,
              url.host?.lowercased() == Self.authCallbackURL.host else {
            throw TendRepositoryError.invalidAuthCallback
        }
        _ = try await client.auth.session(from: url)
    }

    func signOut() async throws {
        try await client.auth.signOut()
    }

    func loadSnapshot() async throws -> MobileSnapshot {
        async let feedRows: [MobileFeedRow] = client
            .from("mobile_feeds")
            .select("payload")
            .order("position")
            .execute()
            .value
        async let cardRows: [MobileCardRow] = client
            .from("mobile_cards")
            .select("payload")
            .order("review_position", ascending: true, nullsFirst: false)
            .execute()
            .value
        async let mindRows: [MobileMindRow] = client
            .from("mobile_mind_snapshot")
            .select("payload")
            .limit(1)
            .execute()
            .value
        async let activities: [MobileActivity] = client
            .from("mobile_commands")
            .select("id,feed_id,card_id,kind,payload,state,available_at,result_work_id,work_status,response,error,created_at,updated_at")
            .order("updated_at", ascending: false)
            .limit(100)
            .execute()
            .value
        async let syncRows: [MobileSync] = client
            .from("mobile_sync_status")
            .select()
            .limit(1)
            .execute()
            .value

        return try await MobileSnapshot(
            feeds: feedRows.map(\.payload),
            cards: cardRows.map(\.payload),
            mind: mindRows.first?.payload ?? .empty,
            activities: activities,
            sync: syncRows.first
        )
    }

    func submit(_ command: MobileCommandSubmission) async throws -> MobileActivity {
        let rows: [MobileActivity] = try await client
            .rpc("submit_mobile_command", params: SubmitMobileCommandParameters(command: command))
            .execute()
            .value
        guard let activity = rows.first else { throw TendRepositoryError.missingResult }
        return activity
    }

    func cancel(commandID: UUID) async throws -> MobileActivity? {
        let rows: [MobileActivity] = try await client
            .rpc("cancel_mobile_command", params: CancelMobileCommandParameters(commandId: commandID))
            .execute()
            .value
        return rows.first
    }

    func startObserving(_ onChange: @escaping @Sendable () async -> Void) async throws {
        guard channel == nil else { return }
        let channel = client.channel("tend-mobile")
        let commandChanges = channel.postgresChange(
            AnyAction.self,
            schema: "public",
            table: "mobile_commands"
        )
        let statusChanges = channel.postgresChange(
            AnyAction.self,
            schema: "public",
            table: "mobile_sync_status"
        )
        try await channel.subscribeWithError()
        self.channel = channel
        observationTasks = [
            Task {
                for await _ in commandChanges {
                    await onChange()
                }
            },
            Task {
                for await _ in statusChanges {
                    await onChange()
                }
            },
        ]
    }

    func stopObserving() async {
        observationTasks.forEach { $0.cancel() }
        observationTasks = []
        if let channel {
            await client.removeChannel(channel)
        }
        channel = nil
    }
}
