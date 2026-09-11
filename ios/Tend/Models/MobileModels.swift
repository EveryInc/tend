import Foundation

struct MobileSnapshot: Codable, Sendable {
    var feeds: [MobileFeed]
    var cards: [MobileCard]
    var mind: MobileMind
    var activities: [MobileActivity]
    var sync: MobileSync?

    static let empty = MobileSnapshot(
        feeds: [],
        cards: [],
        mind: .empty,
        activities: [],
        sync: nil
    )
}

struct MobileFeed: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let purpose: String
    let position: Int
    let currentPass: Int
    let generation: String
    var reviewCount: Int
    let queuedCount: Int
    let workingCount: Int
    let doneCount: Int
    let latestCardTitle: String?
    let latestCardUpdatedAt: String?
    let updatedAt: String
}

struct MobileCard: Codable, Identifiable, Hashable, Sendable {
    var id: String { key }

    let key: String
    let itemKind: String
    let feedId: String
    let cardId: String
    let routineActionGroupId: String?
    let feedGeneration: String
    let cardDigest: String
    var status: String
    let reviewPosition: Int?
    var reviewable: Bool
    let title: String
    let eyebrow: String
    let why: String
    let sourceMailbox: String?
    let contextInfluence: MobileContextInfluence?
    var blocks: [MobileBlock]
    let actions: [MobileAction]
    let activeWork: MobileWork?
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    var completionDisposition: String? = nil   // "completed" | "dismissed"; nil for legacy snapshots

    var editableBlocks: [MobileBlock] {
        blocks.filter { $0.type == "editable_text" && $0.editable == true }
    }

    var primaryAction: MobileAction? {
        actions.first(where: { $0.variant == "primary" && $0.behavior != "default_cleanup" && $0.behavior != "dismiss_card" })
            ?? actions.first(where: { $0.behavior != "default_cleanup" && $0.behavior != "dismiss_card" })
    }

    var archiveAction: MobileAction? {
        actions.first(where: { $0.behavior == "default_cleanup" })
    }

    var dismissAction: MobileAction? {
        actions.first(where: { $0.behavior == "dismiss_card" })
    }
}

struct MobileContextInfluence: Codable, Hashable, Sendable {
    let updateId: String
    let signalIds: [String]
    let mode: String
    let effect: String
    let summary: String
    let researchQuestion: String?
    let sourceCount: Int?
}

struct MobileAction: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let behavior: String
    let digest: String
    let artifactBlockId: String?
    let externalMutation: Bool?
    let variant: String?
    let confirmation: MobileActionConfirmation?
}

struct MobileActionConfirmation: Codable, Hashable, Sendable {
    let kind: String
    let title: String
    let message: String
    let recipients: [String]
}

struct MobileWork: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let status: String
    let instruction: String?
    let digest: String
    let createdAt: String
    let updatedAt: String
    let response: String?
    let error: String?
}

struct MobileBlock: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let type: String
    let label: String?
    let title: String?
    let text: String?
    var value: String?
    let items: [MobileBlockItem]?
    let before: String?
    let after: String?
    let editable: Bool?
    let profile: MobileProfile?
    let video: MobileVideo?
    let chart: MobileChart?
}

enum MobileBlockItem: Codable, Hashable, Sendable, Identifiable {
    case text(String)
    case detail(MobileEvidenceItem)

    var id: String {
        switch self {
        case .text(let value): "text:\(value)"
        case .detail(let value): "detail:\(value.label):\(value.href ?? "")"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
        } else {
            self = .detail(try container.decode(MobileEvidenceItem.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let value): try container.encode(value)
        case .detail(let value): try container.encode(value)
        }
    }
}

struct MobileEvidenceItem: Codable, Hashable, Sendable {
    let label: String
    let detail: String?
    let checked: Bool?
    let href: String?
    let linkAvailability: String?
}

struct MobileProfile: Codable, Hashable, Sendable {
    let name: String
    let subtitle: String?
    let href: String?
    let imageUrl: String?
    let fallbackImageUrl: String?
    let links: [MobileProfileLink]?
}

struct MobileProfileLink: Codable, Hashable, Sendable {
    let label: String
    let href: String?
    let linkAvailability: String?
}

struct MobileVideo: Codable, Hashable, Sendable {
    let title: String
    let href: String?
    let linkAvailability: String?
}

struct MobileChart: Codable, Hashable, Sendable {
    let unit: String?
    let max: Double
    let series: [MobileChartSeries]
    let rows: [MobileChartRow]
    let note: String?
}

struct MobileChartSeries: Codable, Hashable, Sendable {
    let label: String
}

struct MobileChartRow: Codable, Hashable, Sendable {
    let label: String
    let values: [Double]
    let detail: String?
}

struct MobileMind: Codable, Hashable, Sendable {
    let health: String
    let current: MobileMindUpdate?
    let lastFresh: MobileMindHistory?
    let history: [MobileMindHistory]

    static let empty = MobileMind(health: "never_published", current: nil, lastFresh: nil, history: [])
}

struct MobileMindUpdate: Codable, Hashable, Sendable {
    let id: String
    let state: String
    let publishedAt: String
    let observedFrom: String
    let observedTo: String
    let summary: String
    let signals: [MobileMindSignal]
    let observations: [MobileMindObservation]
    let contentDigest: String
    let freshUntil: String?
}

struct MobileMindSignal: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let title: String
    let summary: String
    let observationIds: [String]
}

struct MobileMindObservation: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let title: String
    let app: String?
    let artifact: String?
    let observedFrom: String
    let observedTo: String
    let excerpt: String
    let fullText: String?
    let href: String?
    let redactionCount: Int?
}

struct MobileMindHistory: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let state: String
    let publishedAt: String
    let observedFrom: String?
    let observedTo: String?
    let summary: String?
    let reason: String?
    let signalCount: Int
    let sourceCount: Int
}

struct MobileSync: Codable, Hashable, Sendable {
    let workerId: String
    let schemaVersion: Int
    let snapshotGeneration: String
    let lastHeartbeatAt: String
    let lastError: String?
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case workerId = "worker_id"
        case schemaVersion = "schema_version"
        case snapshotGeneration = "snapshot_generation"
        case lastHeartbeatAt = "last_heartbeat_at"
        case lastError = "last_error"
        case updatedAt = "updated_at"
    }
}

extension String {
    var tendDate: Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: self) {
            return date
        }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        if let date = standard.date(from: self) {
            return date
        }
        let legacy = DateFormatter()
        legacy.locale = Locale(identifier: "en_US_POSIX")
        legacy.timeZone = TimeZone(secondsFromGMT: 0)
        legacy.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        return legacy.date(from: self)
    }
}

extension Date {
    var tendTimestamp: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: self)
    }
}
