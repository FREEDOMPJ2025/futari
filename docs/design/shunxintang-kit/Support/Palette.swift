import SwiftUI
import UIKit

/// 沿用 Catch-22 順心堂的剪紙拼貼風：紙色＋墨黑為底，
/// 搭配高飽和的番茄橘、鈷藍、芥末黃、草綠、梅紫。不用警告紅：沒做也不是錯。
enum Palette {
    // 基底：紙與墨
    static let background = Color(light: 0xF4EFE6, dark: 0x141414)
    static let surface    = Color(light: 0xFFFCF6, dark: 0x232220)
    static let ink        = Color(light: 0x161616, dark: 0xF4EFE6)
    static let inkSoft    = Color(light: 0x5E5850, dark: 0xA9A39A)

    // 角色色
    static let pro        = Color(light: 0xF0643F, dark: 0xFF7650)   // 番茄橘（阿正）
    static let proSoft    = Color(light: 0xFBD8CB, dark: 0x4A2418)
    static let con        = Color(light: 0x3A5BD9, dark: 0x6F8BFF)   // 鈷藍（角頭）
    static let conSoft    = Color(light: 0xD8DFFA, dark: 0x1F2750)

    // 主色：墨黑（深色模式反轉成紙色），按鈕像一張黑色貼紙
    static let accent     = Color(light: 0x161616, dark: 0xF4EFE6)
    static let onAccent   = Color(light: 0xF4EFE6, dark: 0x161616)
    static let accentSoft = Color(light: 0xE8E0D2, dark: 0x302E2A)
    /// 紙色元件外圈的淡墨線（取代錯位陰影）
    static let hairline   = Color(light: 0x161616, dark: 0xF4EFE6).opacity(0.14)

    // 點綴色
    static let sun        = Color(light: 0xF4C23C, dark: 0xFFD04F)   // 芥末黃（阿和）
    static let mint       = Color(light: 0x2E9E5E, dark: 0x45C27B)   // 草綠
    static let lilac      = Color(light: 0xA64CA6, dark: 0xC76BC7)   // 梅紫

    /// 拼貼裝飾輪替用
    static let playful: [Color] = [pro, con, sun, mint, lilac]

    /// 拍立得相紙：深色模式也保持紙白，上面的字固定用深墨
    static let photoPaper = Color(light: 0xFFFCF6, dark: 0xF4EFE6)
    static let fixedInk   = Color(light: 0x161616, dark: 0x161616)
    static let fixedInkSoft = Color(light: 0x5E5850, dark: 0x5E5850)
    static let fixedPaper = Color(light: 0xFFFCF6, dark: 0xFFFCF6)
}

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - 共用樣式（與順心堂相同）

/// 手剪紙片形狀：四角與邊緣帶一點不規則，同一個 seed 永遠長一樣
struct PaperShape: Shape {
    var seed: Int = 1
    var wobble: CGFloat = 3

    func path(in rect: CGRect) -> Path {
        func jitter(_ index: Int) -> CGFloat {
            // 簡單的決定性雜湊，避免每次重繪都變形
            let value = sin(Double(seed * 97 + index * 31)) * 43758.5453
            return CGFloat(value - floor(value)) * 2 - 1
        }
        let w = wobble
        let corners = [
            CGPoint(x: rect.minX + jitter(0) * w, y: rect.minY + jitter(1) * w),
            CGPoint(x: rect.maxX + jitter(2) * w, y: rect.minY + jitter(3) * w),
            CGPoint(x: rect.maxX + jitter(4) * w, y: rect.maxY + jitter(5) * w),
            CGPoint(x: rect.minX + jitter(6) * w, y: rect.maxY + jitter(7) * w)
        ]
        var path = Path()
        path.move(to: corners[0])
        for index in 0..<4 {
            let a = corners[index]
            let b = corners[(index + 1) % 4]
            let mid = CGPoint(
                x: (a.x + b.x) / 2 + jitter(10 + index) * w * 0.5,
                y: (a.y + b.y) / 2 + jitter(20 + index) * w * 0.5
            )
            path.addLine(to: mid)
            path.addLine(to: b)
        }
        path.closeSubpath()
        return path
    }
}

/// 剪紙卡片：平貼在紙上，不用錯位陰影；紙色卡片加一圈淡淡的墨線，讓它從底色浮出來
struct SoftCard: ViewModifier {
    var fill: Color = Palette.surface
    var seed: Int = 1
    var outlined: Bool = true
    var padding: CGFloat = 20

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                PaperShape(seed: seed, wobble: 2.5)
                    .fill(fill)
                    .overlay {
                        if outlined {
                            PaperShape(seed: seed, wobble: 2.5)
                                .stroke(Palette.hairline, lineWidth: 1.2)
                        }
                    }
            )
    }
}

extension View {
    func softCard(fill: Color = Palette.surface, seed: Int = 1, outlined: Bool = true, padding: CGFloat = 20) -> some View {
        modifier(SoftCard(fill: fill, seed: seed, outlined: outlined, padding: padding))
    }

    /// 剪紙小名牌（例如「No.03」「任務描述」）
    func paperTag(fill: Color = Palette.accent, foreground: Color = Palette.onAccent, seed: Int = 61) -> some View {
        self
            .font(.caption.weight(.black))
            .foregroundStyle(foreground)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(fill, in: PaperShape(seed: seed, wobble: 1.2))
    }
}

/// 剪紙貼紙按鈕：平貼、沒有錯位陰影，按下時輕輕縮一下
struct CalmButtonStyle: ButtonStyle {
    var fill: Color = Palette.accent
    var foreground: Color = Palette.onAccent
    var outlined = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        return configuration.label
            .font(.headline.weight(.heavy))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                PaperShape(seed: 3, wobble: 2)
                    .fill(fill)
                    .overlay {
                        if outlined {
                            PaperShape(seed: 3, wobble: 2)
                                .stroke(Palette.hairline, lineWidth: 1.5)
                        }
                    }
            )
            .scaleEffect(pressed ? 0.97 : 1)
            .opacity(isEnabled ? (pressed ? 0.85 : 1) : 0.4)
            .animation(.spring(response: 0.2, dampingFraction: 0.6), value: pressed)
    }
}

extension ButtonStyle where Self == CalmButtonStyle {
    /// 次要按鈕：紙色貼紙＋淡墨線
    static var paper: CalmButtonStyle { CalmButtonStyle(fill: Palette.surface, foreground: Palette.ink, outlined: true) }
    /// 最輕的文字按鈕
    static var quiet: CalmButtonStyle { CalmButtonStyle(fill: .clear, foreground: Palette.inkSoft) }
}
