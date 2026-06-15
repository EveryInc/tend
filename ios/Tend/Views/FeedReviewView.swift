import SwiftUI
import UIKit

struct FeedReviewView: View {
    @Bindable var model: TendAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var activeFeedID: String
    @State private var edits: [String: String] = [:]
    @State private var showComposer = false
    @State private var approvalAction: MobileAction?
    @State private var safariDestination: SafariDestination?

    init(model: TendAppModel, feedID: String) {
        self.model = model
        _activeFeedID = State(initialValue: feedID)
    }

    private var feed: MobileFeed? {
        model.feed(for: activeFeedID)
    }

    private var cards: [MobileCard] {
        model.cards(for: activeFeedID)
    }

    private var card: MobileCard? {
        cards.first
    }

    var body: some View {
        ZStack {
            TendTheme.paper.ignoresSafeArea()

            if let feed, let card {
                cardDeck(feed: feed, card: card)
            } else if let feed {
                EmptyFeedView(feed: feed, nextFeed: nextWaitingFeed) {
                    model.selectedFeedID = nextWaitingFeed?.id
                    dismiss()
                }
            } else {
                ContentUnavailableView(
                    "Feed unavailable",
                    systemImage: "rectangle.stack.badge.minus",
                    description: Text("This feed may have been renamed or removed on the Mac.")
                )
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(feed?.name ?? "Feed")
                        .font(.headline)
                    Text(cards.isEmpty ? "All clear" : "\(cards.count) left")
                        .font(.caption)
                        .foregroundStyle(TendTheme.secondaryInk)
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) {
                feedSwitcher
            }
        }
        .toolbarBackground(TendTheme.paper, for: .navigationBar)
        .sheet(isPresented: $showComposer) {
            if let card {
                InstructionComposer(model: model, card: card) { succeeded in
                    if succeeded {
                        finishFeedIfNeeded()
                    }
                }
            }
        }
        .sheet(item: $approvalAction) { action in
            if let card {
                ActionApprovalSheet(
                    card: card,
                    action: action,
                    edits: $edits
                ) {
                    let succeeded = await model.submit(action: action, for: card, edits: edits)
                    if succeeded {
                        haptic(.success)
                        finishFeedIfNeeded()
                    }
                    return succeeded
                }
            }
        }
        .sheet(item: $safariDestination) { destination in
            SafariSheet(url: destination.url)
                .ignoresSafeArea()
        }
        .environment(\.openURL, OpenURLAction { url in
            openURL(url.absoluteString)
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .handled : .systemAction
        })
        .onChange(of: card?.key, initial: true) { _, _ in
            resetEdits()
        }
    }

    private func cardDeck(feed: MobileFeed, card: MobileCard) -> some View {
        ScrollView {
            VStack(spacing: 14) {
                reviewProgress(feed: feed)

                MobileCardView(
                    card: card,
                    edits: $edits,
                    openURL: openURL,
                    openMind: {
                        model.selectedTab = 1
                        dismiss()
                    }
                )
                .offset(x: 0)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 24)
                        .onEnded { value in
                            guard value.translation.width < -90,
                                  abs(value.translation.width) > abs(value.translation.height) * 1.35,
                                  card.archiveAction != nil else { return }
                            archive(card)
                        }
                )

                Text("Swipe left to archive")
                    .font(.caption)
                    .foregroundStyle(TendTheme.secondaryInk)
                    .padding(.bottom, 4)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 124)
        }
        .safeAreaInset(edge: .bottom) {
            ReviewActionTray(
                card: card,
                isSubmitting: model.isSubmitting,
                archive: { archive(card) },
                talkOrType: { showComposer = true },
                selectAction: { action in
                    handle(action: action, card: card)
                }
            )
        }
    }

    private func reviewProgress(feed: MobileFeed) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "rectangle.stack.fill")
                .foregroundStyle(TendTheme.cobalt)
            Text(feed.purpose)
                .font(.caption)
                .foregroundStyle(TendTheme.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Text("Pass \(feed.currentPass)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(TendTheme.secondaryInk)
        }
        .padding(.top, 8)
    }

    private var feedSwitcher: some View {
        Menu {
            ForEach(model.snapshot.feeds.sorted(by: { $0.position < $1.position })) { item in
                Button {
                    activeFeedID = item.id
                    model.selectedFeedID = item.id
                } label: {
                    Label {
                        Text("\(item.name) · \(item.reviewCount)")
                    } icon: {
                        Image(systemName: item.id == activeFeedID ? "checkmark.circle.fill" : "circle")
                    }
                }
            }
        } label: {
            Image(systemName: "arrow.triangle.swap")
        }
        .accessibilityLabel("Switch feed")
    }

    private var nextWaitingFeed: MobileFeed? {
        model.snapshot.feeds
            .filter { $0.id != activeFeedID && $0.reviewCount > 0 }
            .sorted { $0.position < $1.position }
            .first
    }

    private func archive(_ card: MobileCard) {
        guard let action = card.archiveAction, !model.isSubmitting else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            let succeeded = await model.submit(action: action, for: card, edits: [:])
            if succeeded {
                finishFeedIfNeeded()
            }
        }
    }

    private func handle(action: MobileAction, card: MobileCard) {
        guard !model.isSubmitting else { return }
        if action.confirmation != nil || action.artifactBlockId != nil {
            approvalAction = action
            return
        }
        Task {
            let succeeded = await model.submit(action: action, for: card, edits: edits)
            if succeeded {
                haptic(.success)
                finishFeedIfNeeded()
            }
        }
    }

    private func finishFeedIfNeeded() {
        guard model.cards(for: activeFeedID).isEmpty else { return }
        model.selectedFeedID = nextWaitingFeed?.id
        dismiss()
    }

    private func resetEdits() {
        guard let card else {
            edits = [:]
            return
        }
        edits = Dictionary(uniqueKeysWithValues: card.editableBlocks.map { ($0.id, $0.value ?? "") })
    }

    private func openURL(_ value: String) {
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return }
        safariDestination = SafariDestination(url: url)
    }

    private func haptic(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
}

private struct ReviewActionTray: View {
    let card: MobileCard
    let isSubmitting: Bool
    let archive: () -> Void
    let talkOrType: () -> Void
    let selectAction: (MobileAction) -> Void

    private var namedActions: [MobileAction] {
        card.actions.filter { $0.behavior != "default_cleanup" }
    }

    var body: some View {
        VStack(spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    archiveButton
                    talkButton
                }
                VStack(spacing: 8) {
                    talkButton
                    archiveButton
                }
            }

            ForEach(namedActions) { action in
                Button {
                    selectAction(action)
                } label: {
                    HStack {
                        Text(action.label)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        if isSubmitting {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: action.externalMutation == true ? "checkmark.seal.fill" : "arrow.right")
                        }
                    }
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(.borderedProminent)
                .tint(TendTheme.actionFill)
                .disabled(isSubmitting)
                .accessibilityHint(
                    action.externalMutation == true
                        ? "Approves this exact action after any required confirmation"
                        : "Queues this exact action for Codex"
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }

    private var archiveButton: some View {
        Button(action: archive) {
            Label("Archive", systemImage: "archivebox")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(TendSecondaryButtonStyle())
        .disabled(isSubmitting || card.archiveAction == nil)
    }

    private var talkButton: some View {
        Button(action: talkOrType) {
            Label("Talk or type", systemImage: "waveform")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(TendSecondaryButtonStyle())
        .disabled(isSubmitting)
    }
}

private struct EmptyFeedView: View {
    let feed: MobileFeed
    let nextFeed: MobileFeed?
    let done: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(TendTheme.sage)
            Text("\(feed.name) is clear")
                .font(.tendSerif(.title))
                .multilineTextAlignment(.center)
            if let nextFeed {
                Text("\(nextFeed.name) has \(nextFeed.reviewCount) waiting.")
                    .foregroundStyle(TendTheme.secondaryInk)
                Button("Back to feeds") {
                    done()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            } else {
                Text("Nothing else needs review right now.")
                    .foregroundStyle(TendTheme.secondaryInk)
                Button("Back to feeds") {
                    done()
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
        }
        .padding(30)
    }
}

private struct InstructionComposer: View {
    @Bindable var model: TendAppModel
    let card: MobileCard
    let onComplete: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var text: String

    init(model: TendAppModel, card: MobileCard, onComplete: @escaping (Bool) -> Void) {
        self.model = model
        self.card = card
        self.onComplete = onComplete
        _text = State(initialValue: model.drafts[card.key] ?? "")
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.title)
                        .font(.headline)
                        .lineLimit(2)
                    Label("Use the Monologue keyboard or type normally", systemImage: "waveform")
                        .font(.caption)
                        .foregroundStyle(TendTheme.secondaryInk)
                }

                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Tell Codex what to notice, change, research, or do…")
                            .foregroundStyle(TendTheme.secondaryInk)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $text)
                        .focused($isFocused)
                        .scrollContentBackground(.hidden)
                        .font(.body)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel("Instruction for Codex")
                }
                .padding(10)
                .background(TendTheme.paperRaised)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(TendTheme.hairline)
                }
            }
            .padding(16)
            .background(TendTheme.paper.ignoresSafeArea())
            .navigationTitle("Talk or type")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        Task {
                            let succeeded = await model.submitInstruction(for: card, text: text)
                            onComplete(succeeded)
                            if succeeded { dismiss() }
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSubmitting)
                }
            }
        }
        .onAppear { isFocused = true }
        .onChange(of: text) { _, value in
            model.updateDraft(value, for: card)
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(model.isSubmitting)
    }
}

private struct ActionApprovalSheet: View {
    let card: MobileCard
    let action: MobileAction
    @Binding var edits: [String: String]
    let approve: () async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var isApproving = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: action.externalMutation == true ? "checkmark.seal.fill" : "arrow.right.circle.fill")
                            .font(.title)
                            .foregroundStyle(action.externalMutation == true ? TendTheme.amber : TendTheme.cobalt)
                        Text(action.label)
                            .font(.tendSerif(.title))
                        Text(card.title)
                            .font(.subheadline)
                            .foregroundStyle(TendTheme.secondaryInk)
                    }

                    if let confirmation = action.confirmation {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(confirmation.title)
                                .font(.headline)
                            Text(confirmation.message)
                                .foregroundStyle(TendTheme.secondaryInk)
                            if !confirmation.recipients.isEmpty {
                                Text(confirmation.recipients.joined(separator: ", "))
                                    .font(.subheadline.monospaced())
                                    .textSelection(.enabled)
                            }
                        }
                        .padding(16)
                        .background(TendTheme.amber.opacity(0.09))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }

                    ForEach(approvedBlocks) { block in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(block.label ?? "Approved text")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TendTheme.secondaryInk)
                                .textCase(.uppercase)
                            TextEditor(text: editBinding(for: block))
                                .font(.body)
                                .frame(minHeight: 180)
                                .padding(10)
                                .scrollContentBackground(.hidden)
                                .background(TendTheme.paperRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(TendTheme.hairline)
                                }
                                .accessibilityLabel(block.label ?? "Approved text")
                        }
                    }

                    Text("Your tap authorizes this one exact action and the visible text above. If the card, action, recipient, mailbox, or digest changes, Tend rejects it.")
                        .font(.footnote)
                        .foregroundStyle(TendTheme.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(18)
            }
            .background(TendTheme.paper)
            .navigationTitle("Confirm action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isApproving)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    isApproving = true
                    Task {
                        let succeeded = await approve()
                        isApproving = false
                        if succeeded { dismiss() }
                    }
                } label: {
                    HStack {
                        if isApproving {
                            ProgressView()
                                .tint(.white)
                        }
                        Text(action.label)
                            .frame(maxWidth: .infinity)
                    }
                    .font(.headline)
                    .frame(minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                .tint(TendTheme.actionFill)
                .padding(16)
                .background(.ultraThinMaterial)
                .disabled(isApproving)
            }
        }
        .interactiveDismissDisabled(isApproving)
        .presentationDetents([.large])
    }

    private func editBinding(for block: MobileBlock) -> Binding<String> {
        Binding(
            get: { edits[block.id] ?? block.value ?? "" },
            set: { edits[block.id] = $0 }
        )
    }

    private var approvedBlocks: [MobileBlock] {
        guard let blockID = action.artifactBlockId else { return [] }
        return card.editableBlocks.filter { $0.id == blockID }
    }
}
