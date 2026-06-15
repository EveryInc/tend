import SwiftUI
import UIKit

enum TendTheme {
    static let paper = adaptive(
        light: (0.965, 0.957, 0.929),
        dark: (0.075, 0.073, 0.062)
    )
    static let paperRaised = adaptive(
        light: (0.992, 0.988, 0.972),
        dark: (0.115, 0.110, 0.094)
    )
    static let ink = adaptive(
        light: (0.105, 0.102, 0.090),
        dark: (0.955, 0.940, 0.886)
    )
    static let secondaryInk = adaptive(
        light: (0.34, 0.33, 0.30),
        dark: (0.76, 0.73, 0.66)
    )
    static let hairline = adaptive(
        light: (0.84, 0.82, 0.75),
        dark: (0.28, 0.26, 0.22)
    )
    static let cobalt = adaptive(
        light: (0.13, 0.33, 0.80),
        dark: (0.52, 0.66, 1.0)
    )
    static let sage = adaptive(
        light: (0.37, 0.47, 0.34),
        dark: (0.55, 0.68, 0.48)
    )
    static let amber = adaptive(
        light: (0.64, 0.43, 0.20),
        dark: (0.88, 0.64, 0.34)
    )
    static let danger = adaptive(
        light: (0.65, 0.18, 0.15),
        dark: (0.95, 0.40, 0.36)
    )
    static let actionFill = adaptive(
        light: (0.105, 0.102, 0.090),
        dark: (0.18, 0.34, 0.72)
    )
    static let corner: CGFloat = 20

    private static func adaptive(
        light: (CGFloat, CGFloat, CGFloat),
        dark: (CGFloat, CGFloat, CGFloat)
    ) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: value.0, green: value.1, blue: value.2, alpha: 1)
        })
    }
}

extension Font {
    static func tendSerif(_ style: Font.TextStyle) -> Font {
        .system(style, design: .serif, weight: .medium)
    }
}

struct TendCardSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(TendTheme.paperRaised)
            .clipShape(RoundedRectangle(cornerRadius: TendTheme.corner, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: TendTheme.corner, style: .continuous)
                    .stroke(TendTheme.hairline.opacity(0.8), lineWidth: 1)
            }
    }
}

struct TendSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(TendTheme.ink)
            .background(configuration.isPressed ? TendTheme.hairline.opacity(0.35) : TendTheme.paperRaised)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TendTheme.secondaryInk, lineWidth: 1)
            }
    }
}

extension View {
    func tendCardSurface() -> some View {
        modifier(TendCardSurface())
    }
}
