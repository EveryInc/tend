import SwiftUI

struct ActivityView: View {
    @Bindable var model: TendAppModel
    @State private var feedFilter = "__all__"
    @State private var selectedActivity: MobileActivity?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var activities: [MobileActivity] {
        model.snapshot.activities
            .filter { feedFilter == "__all__" || $0.feedId == feedFilter }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TendTheme.paper.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        Group {
                            if dynamicTypeSize.isAccessibilitySize {
                                VStack(alignment: .leading, spacing: 10) {
                                    TendWordmark(subtitle: "What the phone recorded and what Codex did next")
                                    SyncBadge(sync: model.snapshot.sync)
                                }
                            } else {
                                HStack(alignment: .top) {
                                    TendWordmark(subtitle: "What the phone recorded and what Codex did next")
                                    Spacer()
                                    SyncBadge(sync: model.snapshot.sync)
                                        .padding(.top, 8)
                                }
                            }
                        }
                        .padding(.bottom, 6)

                        if activities.isEmpty {
                            ContentUnavailableView(
                                "No activity",
                                systemImage: "clock",
                                description: Text("Phone actions and their Mac progress will appear here.")
                            )
                            .padding(.top, 70)
                        } else {
                            ForEach(activities) { activity in
                                Button {
                                    selectedActivity = activity
                                } label: {
                                    ActivityRow(
                                        activity: activity,
                                        feed: model.feed(for: activity.feedId)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 28)
                }
                .refreshable {
                    await model.refresh()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Feed", selection: $feedFilter) {
                            Text("All feeds").tag("__all__")
                            ForEach(model.snapshot.feeds.sorted(by: { $0.position < $1.position })) { feed in
                                Text(feed.name).tag(feed.id)
                            }
                        }
                    } label: {
                        Label(
                            feedFilter == "__all__" ? "All feeds" : model.feed(for: feedFilter)?.name ?? "Feed",
                            systemImage: "line.3.horizontal.decrease.circle"
                        )
                    }
                }
            }
            .toolbarBackground(TendTheme.paper, for: .navigationBar)
            .sheet(item: $selectedActivity) { activity in
                ActivityDetailView(
                    model: model,
                    activity: activity,
                    card: model.activityCard(activity)
                )
            }
        }
    }
}

private struct ActivityRow: View {
    let activity: MobileActivity
    let feed: MobileFeed?

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon)
                .font(.headline)
                .foregroundStyle(tone)
                .frame(width: 28, height: 28)
                .background(tone.opacity(0.1))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(feed?.name ?? activity.feedId.titleCasedIdentifier)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(activity.updatedAt.tendDate?.tendRelative ?? "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(title)
                    .font(.headline)
                    .foregroundStyle(TendTheme.ink)
                    .multilineTextAlignment(.leading)
                if let response = activity.response, !response.isEmpty {
                    Text(response)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                } else if let error = activity.error, !error.isEmpty {
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.danger)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                StateBadge(text: activity.displayState, tone: tone)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .tendCardSurface()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(feed?.name ?? activity.feedId), \(title), \(activity.displayState)")
    }

    private var title: String {
        if let instruction = activity.payload.instruction, !instruction.isEmpty {
            return instruction
        }
        switch activity.kind {
        case "archive": return "Archived card"
        case "dismiss": return "Dismissed card"
        case "approve_action": return "Approved action"
        case "approve_routine_action": return "Approved routine"
        case "return_to_review": return "Returned card to review"
        case "edit_queued_instruction": return "Edited queued note"
        default: return activity.kind.titleCasedIdentifier
        }
    }

    private var tone: Color {
        if activity.state == "rejected" || ["failed", "stale"].contains(activity.workStatus) {
            return TendTheme.danger
        }
        if activity.workStatus == "completed" {
            return TendTheme.sage
        }
        if activity.state == "pending" || activity.workStatus == "queued" {
            return TendTheme.amber
        }
        return TendTheme.cobalt
    }

    private var icon: String {
        switch activity.kind {
        case "archive": "archivebox.fill"
        case "dismiss": "checkmark.circle.fill"
        case "approve_action", "approve_routine_action": "checkmark.seal.fill"
        case "instruction", "edit_queued_instruction": "text.bubble.fill"
        case "return_to_review": "arrow.uturn.backward.circle.fill"
        default: "clock.fill"
        }
    }
}

private struct ActivityDetailView: View {
    @Bindable var model: TendAppModel
    let activity: MobileActivity
    let card: MobileCard?
    @Environment(\.dismiss) private var dismiss
    @State private var note: String
    @State private var isEditing = false

    init(model: TendAppModel, activity: MobileActivity, card: MobileCard?) {
        self.model = model
        self.activity = activity
        self.card = card
        _note = State(initialValue: card?.activeWork?.instruction ?? activity.payload.instruction ?? "")
    }

    private var canEdit: Bool {
        card?.activeWork?.status == "queued"
            && ["instruction", "scoped_instruction"].contains(card?.activeWork?.kind ?? "")
    }

    private var canReturn: Bool {
        guard let status = card?.activeWork?.status else { return false }
        return status == "queued" || status == "approved_blocked"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.feed(for: activity.feedId)?.name ?? activity.feedId.titleCasedIdentifier)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                        Text(card?.title ?? activity.payload.instruction ?? activity.kind.titleCasedIdentifier)
                            .font(.tendSerif(.title))
                            .fixedSize(horizontal: false, vertical: true)
                        StateBadge(text: activity.displayState, tone: statusTone)
                    }

                    detailRow("Recorded", value: activity.createdAt.tendDate?.formatted(date: .abbreviated, time: .shortened) ?? activity.createdAt)
                    detailRow("Command", value: activity.kind.titleCasedIdentifier)
                    if let work = activity.resultWorkId {
                        detailRow("Work", value: work)
                    }

                    if let response = activity.response, !response.isEmpty {
                        messagePanel("Result", text: response, tone: TendTheme.sage)
                    }
                    if let error = activity.error, !error.isEmpty {
                        messagePanel("What changed", text: error, tone: TendTheme.danger)
                    }

                    if isEditing, canEdit {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("QUEUED NOTE")
                                .font(.caption.weight(.bold))
                                .tracking(0.8)
                                .foregroundStyle(.secondary)
                            TextEditor(text: $note)
                                .frame(minHeight: 170)
                                .padding(10)
                                .scrollContentBackground(.hidden)
                                .background(TendTheme.paperRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(TendTheme.hairline)
                                }
                        }
                    }

                    if canEdit {
                        Button(isEditing ? "Save edited note" : "Edit queued note") {
                            if isEditing, let card {
                                Task {
                                    if await model.editQueuedNote(for: card, instruction: note) {
                                        dismiss()
                                    }
                                }
                            } else {
                                isEditing = true
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.isSubmitting || (isEditing && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }

                    if canReturn, let card {
                        Button("Move back to review") {
                            Task {
                                if await model.returnToReview(card) {
                                    dismiss()
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(model.isSubmitting)
                    }

                    if canEdit || canReturn {
                        Text("Moving a card back cancels queued work. Tend refuses once Codex has started working.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(18)
            }
            .background(TendTheme.paper)
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var statusTone: Color {
        if activity.state == "rejected" || ["failed", "stale"].contains(activity.workStatus) {
            return TendTheme.danger
        }
        if activity.workStatus == "completed" { return TendTheme.sage }
        return TendTheme.cobalt
    }

    private func detailRow(_ label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .font(.subheadline)
    }

    private func messagePanel(_ label: String, text: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(tone)
            Text(text)
                .foregroundStyle(TendTheme.secondaryInk)
                .textSelection(.enabled)
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}
