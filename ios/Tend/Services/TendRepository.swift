import Foundation

protocol TendRepository: Sendable {
    var usesFixtures: Bool { get }

    func hasSession() async -> Bool
    func requestSignInLink(email: String) async throws
    func handleAuthCallback(_ url: URL) async throws
    func signOut() async throws
    func loadSnapshot() async throws -> MobileSnapshot
    func submit(_ command: MobileCommandSubmission) async throws -> MobileActivity
    func cancel(commandID: UUID) async throws -> MobileActivity?
    func startObserving(_ onChange: @escaping @Sendable () async -> Void) async throws
    func stopObserving() async
}

enum TendRepositoryError: LocalizedError {
    case invalidConfiguration
    case invalidAuthCallback
    case missingResult

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Tend's Supabase configuration is missing."
        case .invalidAuthCallback: "Tend received an invalid sign-in link."
        case .missingResult: "Tend did not receive the expected cloud result."
        }
    }
}
