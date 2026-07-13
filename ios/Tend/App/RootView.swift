import SwiftUI

struct RootView: View {
    @Bindable var model: TendAppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.authState {
            case .loading:
                ProgressView("Opening Tend")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(TendTheme.paper)
            case .signedOut, .linkSent:
                SignInView(model: model)
            case .authenticated:
                TendTabView(model: model)
            }
        }
        .tint(TendTheme.cobalt)
        .preferredColorScheme(nil)
        .overlay(alignment: .bottom) {
            if model.pendingUndo != nil {
                UndoArchiveToast(model: model)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: model.pendingUndo?.id)
        .alert(
            "Tend could not finish that",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            ),
            actions: {
                Button("OK", role: .cancel) {
                    model.errorMessage = nil
                }
            },
            message: {
                Text(model.errorMessage ?? "Please try again.")
            }
        )
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, model.authState == .authenticated else { return }
            Task { await model.refresh() }
        }
        .onOpenURL { url in
            Task { await model.handleAuthCallback(url) }
        }
    }
}

private struct TendTabView: View {
    @Bindable var model: TendAppModel

    var body: some View {
        TabView(selection: $model.selectedTab) {
            FeedsView(model: model)
                .tag(0)
                .tabItem {
                    Label("Feeds", systemImage: "rectangle.stack.fill")
                }

            MindView(model: model)
                .tag(1)
                .tabItem {
                    Label("On Your Mind", systemImage: "sparkles")
                }

            ActivityView(model: model)
                .tag(2)
                .tabItem {
                    Label("Activity", systemImage: "clock.arrow.circlepath")
                }
        }
    }
}

private struct UndoArchiveToast: View {
    @Bindable var model: TendAppModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: model.pendingUndo?.kind == "dismiss" ? "checkmark.circle.fill" : "archivebox.fill")
                .foregroundStyle(.white.opacity(0.85))
            Text(model.pendingUndo?.kind == "dismiss" ? "Dismissed" : "Archived")
                .font(.headline)
                .foregroundStyle(.white)
            Spacer()
            Button("Undo") {
                Task { await model.undoArchive() }
            }
            .font(.headline)
            .foregroundStyle(Color(red: 0.83, green: 0.88, blue: 1))
            .accessibilityHint("Restores the card to its feed")
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 56)
        .background(TendTheme.ink.opacity(0.96))
        .clipShape(Capsule())
        .shadow(color: .black.opacity(0.2), radius: 18, y: 8)
    }
}
