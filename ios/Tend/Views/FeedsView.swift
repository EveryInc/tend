import SwiftUI

struct FeedsView: View {
    @Bindable var model: TendAppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var orderedFeeds: [MobileFeed] {
        model.snapshot.feeds.sorted { $0.position < $1.position }
    }

    private var totalReview: Int {
        orderedFeeds.reduce(0) { $0 + $1.reviewCount }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TendTheme.paper.ignoresSafeArea()
                ScrollView {
                    LazyVStack(spacing: 14) {
                        dashboardHeader

                        if model.usesFixtures {
                            previewBanner
                        }

                        if orderedFeeds.isEmpty {
                            ContentUnavailableView(
                                "No feeds yet",
                                systemImage: "rectangle.stack",
                                description: Text("Feeds created in canonical Tend will appear here automatically.")
                            )
                            .padding(.top, 60)
                        } else {
                            ForEach(orderedFeeds) { feed in
                                NavigationLink {
                                    FeedReviewView(model: model, feedID: feed.id)
                                } label: {
                                    FeedRow(
                                        feed: feed,
                                        isSuggested: feed.id == model.selectedFeedID && feed.reviewCount > 0
                                    )
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("feed-\(feed.id)")
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .refreshable {
                    await model.refresh()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        Button(role: .destructive) {
                            Task { await model.signOut() }
                        } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Tend menu")
                }
            }
            .toolbarBackground(TendTheme.paper, for: .navigationBar)
        }
    }

    private var dashboardHeader: some View {
        VStack(alignment: .leading, spacing: 18) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    TendWordmark(subtitle: "Your attention, feed by feed")
                    SyncBadge(sync: model.snapshot.sync)
                }
            } else {
                HStack(alignment: .top) {
                    TendWordmark(subtitle: "Your attention, feed by feed")
                    Spacer()
                    SyncBadge(sync: model.snapshot.sync)
                        .padding(.top, 8)
                }
            }

            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    CountPill(value: totalReview, label: "to review", emphasis: true)
                    CountPill(value: orderedFeeds.reduce(0) { $0 + $1.workingCount }, label: "working")
                    CountPill(value: orderedFeeds.count, label: "feeds")
                }
            } else {
                HStack(spacing: 30) {
                    CountPill(value: totalReview, label: "to review", emphasis: true)
                    CountPill(value: orderedFeeds.reduce(0) { $0 + $1.workingCount }, label: "working")
                    CountPill(value: orderedFeeds.count, label: "feeds")
                    Spacer()
                }
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var previewBanner: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Preview data", systemImage: "sparkles.rectangle.stack")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TendTheme.cobalt)
                    Text("Cloud credentials are not configured.")
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.secondaryInk)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles.rectangle.stack")
                        .foregroundStyle(TendTheme.cobalt)
                        .accessibilityHidden(true)
                    Text("Preview data")
                        .font(.subheadline.weight(.semibold))
                    Text("Cloud credentials are not configured.")
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.secondaryInk)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(14)
        .background(TendTheme.cobalt.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct FeedRow: View {
    let feed: MobileFeed
    let isSuggested: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 7) {
                        Text(feed.name)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(TendTheme.ink)
                        if isSuggested {
                            Text("NEXT")
                                .font(.caption2.weight(.bold))
                                .tracking(0.8)
                                .foregroundStyle(TendTheme.cobalt)
                        }
                    }
                    Text(feed.purpose)
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TendTheme.secondaryInk)
            }

            if let latest = feed.latestCardTitle {
                Text(latest)
                    .font(.system(.body, design: .serif, weight: .medium))
                    .foregroundStyle(TendTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 20) {
                Text("\(feed.reviewCount) to review")
                    .fontWeight(.semibold)
                    .foregroundStyle(feed.reviewCount > 0 ? TendTheme.ink : TendTheme.secondaryInk)
                Text("\(feed.workingCount) working")
                    .foregroundStyle(TendTheme.secondaryInk)
                Spacer()
                Text(feed.relativeFreshness)
                    .foregroundStyle(TendTheme.secondaryInk)
            }
            .font(.caption.weight(.semibold))
        }
        .padding(18)
        .tendCardSurface()
        .overlay(alignment: .leading) {
            if feed.reviewCount > 0 {
                Capsule()
                    .fill(isSuggested ? TendTheme.cobalt : TendTheme.sage)
                    .frame(width: 4)
                    .padding(.vertical, 16)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(feed.name), \(feed.reviewCount) to review, \(feed.workingCount) working, updated \(feed.relativeFreshness)"
        )
    }
}
