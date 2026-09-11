import SwiftUI

struct TendWordmark: View {
    let subtitle: String?

    init(subtitle: String? = nil) {
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Tend")
                .font(.system(.largeTitle, design: .serif, weight: .semibold))
                .foregroundStyle(TendTheme.ink)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(TendTheme.secondaryInk)
            }
        }
    }
}

struct CountPill: View {
    let value: Int
    let label: String
    var emphasis = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.headline.monospacedDigit())
                .foregroundStyle(emphasis ? TendTheme.cobalt : TendTheme.ink)
            Text(label)
                .font(.caption)
                .foregroundStyle(TendTheme.secondaryInk)
        }
        .accessibilityElement(children: .combine)
    }
}

struct SyncBadge: View {
    let sync: MobileSync?

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(TendTheme.secondaryInk)
        .accessibilityLabel("Sync status: \(label)")
    }

    private var isRecent: Bool {
        guard let heartbeat = sync?.lastHeartbeatAt.tendDate else { return false }
        return Date().timeIntervalSince(heartbeat) < 90
    }

    private var color: Color {
        if sync?.lastError != nil { return TendTheme.danger }
        return isRecent ? TendTheme.sage : TendTheme.amber
    }

    private var label: String {
        if sync?.lastError != nil { return "Needs attention" }
        if isRecent { return "Synced" }
        return sync == nil ? "Cached" : "Mac offline"
    }
}

struct StateBadge: View {
    let text: String
    let tone: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .foregroundStyle(tone)
            .background(tone.opacity(0.11))
            .clipShape(Capsule())
    }
}

extension Date {
    var tendRelative: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}

extension MobileFeed {
    var relativeFreshness: String {
        (latestCardUpdatedAt?.tendDate ?? updatedAt.tendDate)?.tendRelative ?? "Unknown"
    }
}

extension String {
    var titleCasedIdentifier: String {
        replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
}
