import SwiftUI

struct MobileCardView: View {
    let card: MobileCard
    @Binding var edits: [String: String]
    let openURL: (String) -> Void
    let openMind: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 11) {
                Text(card.eyebrow.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TendTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text(card.title)
                    .font(.system(.title, design: .serif, weight: .medium))
                    .foregroundStyle(TendTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(card.why)
                    .font(.body)
                    .foregroundStyle(TendTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let influence = card.contextInfluence {
                ContextInfluenceView(influence: influence, openMind: openMind)
            }

            ForEach(card.blocks) { block in
                MobileBlockView(
                    block: block,
                    edit: editBinding(for: block),
                    openURL: openURL
                )
            }

            if let mailbox = card.sourceMailbox {
                Label("Acts as \(mailbox)", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.caption)
                    .foregroundStyle(TendTheme.secondaryInk)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .tendCardSurface()
        .accessibilityIdentifier("review-card-\(card.feedId)-\(card.cardId)")
    }

    private func editBinding(for block: MobileBlock) -> Binding<String> {
        Binding(
            get: { edits[block.id] ?? block.value ?? "" },
            set: { edits[block.id] = $0 }
        )
    }
}

private struct ContextInfluenceView: View {
    let influence: MobileContextInfluence
    let openMind: () -> Void

    var body: some View {
        Button(action: openMind) {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("ON YOUR MIND", systemImage: "sparkles")
                        .font(.caption.weight(.bold))
                        .tracking(0.8)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                }
                Text(influence.summary)
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                if let question = influence.researchQuestion {
                    Text(question)
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.secondaryInk)
                        .multilineTextAlignment(.leading)
                }
                if let count = influence.sourceCount {
                    Text("View context and \(count) \(count == 1 ? "source" : "sources")")
                        .font(.caption.weight(.semibold))
                }
            }
            .foregroundStyle(TendTheme.cobalt)
            .padding(16)
            .background(TendTheme.cobalt.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the On Your Mind workspace")
    }
}

private struct MobileBlockView: View {
    let block: MobileBlock
    @Binding var edit: String
    let openURL: (String) -> Void

    var body: some View {
        Group {
            switch block.type {
            case "memo":
                memo
            case "evidence", "receipt":
                itemList(icon: block.type == "receipt" ? "checkmark.seal" : "link")
            case "options":
                itemList(icon: "circle")
            case "checklist":
                itemList(icon: "checkmark.circle")
            case "editable_text":
                editableText
            case "diff":
                diff
            case "email_thread":
                emailThread
            case "profile":
                profile
            case "video":
                video
            case "chart":
                chart
            default:
                richText
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var memo: some View {
        VStack(alignment: .leading, spacing: 8) {
            blockLabel
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            if let text = block.text {
                markdownText(text)
                    .foregroundStyle(TendTheme.secondaryInk)
            }
        }
        .padding(16)
        .background(TendTheme.paper)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(TendTheme.amber.opacity(0.45))
                .frame(width: 4)
        }
    }

    private func itemList(icon: String) -> some View {
        LazyVStack(alignment: .leading, spacing: 11) {
            blockLabel
            ForEach(block.items ?? []) { item in
                switch item {
                case .text(let value):
                    Label(value, systemImage: icon)
                        .foregroundStyle(TendTheme.secondaryInk)
                case .detail(let detail):
                    if let href = detail.href, detail.linkAvailability != "unavailable" {
                        Button {
                            openURL(href)
                        } label: {
                            itemRow(detail, icon: "arrow.up.right.square")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(TendTheme.cobalt)
                        .accessibilityHint("Opens in an in-app browser")
                    } else {
                        itemRow(detail, icon: detail.checked == true ? "checkmark.circle.fill" : icon)
                            .foregroundStyle(TendTheme.secondaryInk)
                    }
                }
            }
        }
    }

    private func itemRow(_ detail: MobileEvidenceItem, icon: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .frame(width: 18)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.label)
                    .font(.body.weight(.medium))
                    .multilineTextAlignment(.leading)
                if let value = detail.detail {
                    Text(value)
                        .font(.subheadline)
                        .foregroundStyle(TendTheme.secondaryInk)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var editableText: some View {
        VStack(alignment: .leading, spacing: 8) {
            blockLabel
            TextEditor(text: $edit)
                .font(.body)
                .frame(minHeight: 150)
                .padding(10)
                .scrollContentBackground(.hidden)
                .background(TendTheme.paper)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(TendTheme.hairline)
                }
                .accessibilityLabel(block.label ?? "Editable note")
            Text("Edits are included only when you approve the matching action.")
                .font(.caption)
                .foregroundStyle(TendTheme.secondaryInk)
        }
    }

    private var diff: some View {
        VStack(alignment: .leading, spacing: 12) {
            blockLabel
            if let before = block.before {
                diffPanel("Before", text: before, color: TendTheme.danger)
            }
            if let after = block.after {
                diffPanel("After", text: after, color: TendTheme.sage)
            }
        }
    }

    private func diffPanel(_ label: String, text: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.9)
                .foregroundStyle(color)
            Text(text)
                .font(.system(.subheadline, design: .monospaced))
                .textSelection(.enabled)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var emailThread: some View {
        VStack(alignment: .leading, spacing: 8) {
            blockLabel
            if let text = block.text {
                Text(text)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(TendTheme.secondaryInk)
                    .textSelection(.enabled)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(TendTheme.paper)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private var profile: some View {
        VStack(alignment: .leading, spacing: 10) {
            blockLabel
            if let profile = block.profile {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.largeTitle)
                        .foregroundStyle(TendTheme.cobalt.opacity(0.75))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profile.name)
                            .font(.headline)
                        if let subtitle = profile.subtitle {
                            Text(subtitle)
                                .font(.subheadline)
                                .foregroundStyle(TendTheme.secondaryInk)
                        }
                    }
                    Spacer()
                }
                ForEach(profile.links ?? [], id: \.label) { link in
                    if let href = link.href, link.linkAvailability != "unavailable" {
                        Button {
                            openURL(href)
                        } label: {
                            Label(link.label, systemImage: "arrow.up.right.square")
                        }
                    }
                }
            }
        }
    }

    private var video: some View {
        VStack(alignment: .leading, spacing: 9) {
            blockLabel
            if let video = block.video {
                Button {
                    if let href = video.href { openURL(href) }
                } label: {
                    HStack {
                        Image(systemName: "play.circle.fill")
                            .font(.title2)
                        Text(video.title)
                            .font(.headline)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .padding(14)
                    .background(TendTheme.cobalt.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .foregroundStyle(TendTheme.cobalt)
                .disabled(video.href == nil || video.linkAvailability == "unavailable")
            }
        }
    }

    private var chart: some View {
        VStack(alignment: .leading, spacing: 13) {
            blockLabel
            if let chart = block.chart {
                HStack(spacing: 14) {
                    ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                        Label {
                            Text(series.label)
                        } icon: {
                            Circle()
                                .fill(seriesColor(index))
                                .frame(width: 8, height: 8)
                        }
                    }
                    .font(.caption)
                }

                ForEach(chart.rows, id: \.label) { row in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(row.label)
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            if let detail = row.detail {
                                Text(detail)
                                    .font(.caption)
                                    .foregroundStyle(TendTheme.secondaryInk)
                            }
                        }
                        ForEach(Array(row.values.enumerated()), id: \.offset) { index, value in
                            HStack(spacing: 8) {
                                GeometryReader { proxy in
                                    Capsule()
                                        .fill(seriesColor(index))
                                        .frame(width: max(4, proxy.size.width * min(value / max(chart.max, 1), 1)))
                                }
                                .frame(height: 9)
                                Text("\(value.formatted(.number.precision(.fractionLength(0...1))))\(chart.unit ?? "")")
                                    .font(.caption.monospacedDigit())
                                    .frame(width: 48, alignment: .trailing)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(
                                "\(row.label), \(chart.series.indices.contains(index) ? chart.series[index].label : "Series"), \(value.formatted())\(chart.unit ?? "")"
                            )
                        }
                    }
                }

                if let note = chart.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(TendTheme.secondaryInk)
                }
            }
        }
        .padding(16)
        .background(TendTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var richText: some View {
        VStack(alignment: .leading, spacing: 8) {
            blockLabel
            if let title = block.title {
                Text(title)
                    .font(.headline)
            }
            if let text = block.text ?? block.value {
                markdownText(text)
                    .foregroundStyle(TendTheme.secondaryInk)
            }
        }
    }

    @ViewBuilder
    private var blockLabel: some View {
        if let label = block.label {
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(TendTheme.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func markdownText(_ value: String) -> Text {
        if let attributed = try? AttributedString(
            markdown: value,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(attributed)
        }
        return Text(value)
    }

    private func seriesColor(_ index: Int) -> Color {
        [TendTheme.cobalt, TendTheme.sage, TendTheme.amber, TendTheme.danger][index % 4]
    }
}
