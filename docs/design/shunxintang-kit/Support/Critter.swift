import SwiftUI

// MARK: - 角色

/// 順心堂的三位兄弟（沿用 Catch-22 順心堂），都是「剪紙＋蠟筆」風格。
/// 角頭的眼睛是一字瞇眼（話不多、眼很利），跟阿正、阿和的圓點眼做出區別。
/// - 阿正（番茄橘方塊）：動手的任務（觸覺）
/// - 角頭（鈷藍三角）：眼很利，看的任務（視覺）
/// - 阿和（芥末黃星芒）：陪你安靜下來（聽覺、嗅覺、味覺）
enum CritterKind: CaseIterable {
    case yes, hmm, spark

    var color: Color {
        switch self {
        case .yes: Palette.pro
        case .hmm: Palette.con
        case .spark: Palette.sun
        }
    }

    fileprivate var seed: UInt64 {
        switch self {
        case .yes: 7
        case .hmm: 13
        case .spark: 29
        }
    }
}

enum CritterMood: Equatable {
    case idle, happy, worried, thinking, sleepy, celebrate
}

/// 所有角色都在 100×100 的座標中繪製，再依 `size` 縮放。
/// 動畫時邊緣會輕微「抖動」（手繪動畫的 line boil），帶出隨性的粗糙感。
struct Critter: View {
    var kind: CritterKind
    var mood: CritterMood = .idle
    var size: CGFloat = 120
    var facingLeft = false
    var animated = true

    @State private var bob = false
    @State private var blinking = false
    @State private var boil: UInt64 = 0

    var body: some View {
        Canvas { context, canvasSize in
            var painter = CritterPainter(
                context: context,
                scale: canvasSize.width / 100,
                seed: kind.seed &+ boil &* 101
            )
            painter.draw(kind: kind, mood: mood, blinking: blinking)
        }
        .frame(width: size, height: size)
        .scaleEffect(x: facingLeft ? -1 : 1, y: 1)
        .offset(y: animated && bob ? -size * bobAmount : 0)
        .rotationEffect(.degrees(animated && bob && mood == .celebrate ? -4 : 0), anchor: .bottom)
        .animation(.spring(response: 0.3, dampingFraction: 0.55), value: mood)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: facingLeft)
        .accessibilityHidden(true)
        .onAppear {
            guard animated else { return }
            withAnimation(.easeInOut(duration: mood == .celebrate ? 0.4 : 1.4).repeatForever(autoreverses: true)) {
                bob = true
            }
        }
        .task {
            // 手繪抖動：每 0.28 秒換一組筆觸
            guard animated else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(0.28))
                boil = (boil + 1) % 3
            }
        }
        .task {
            guard animated else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Double.random(in: 2.5...4.5)))
                blinking = true
                try? await Task.sleep(for: .seconds(0.14))
                blinking = false
            }
        }
    }

    private var bobAmount: CGFloat {
        switch mood {
        case .celebrate: 0.06
        case .sleepy: 0.012
        default: 0.022
        }
    }
}

/// 三個角色站在一起
struct CritterGang: View {
    var size: CGFloat = 110

    var body: some View {
        HStack(alignment: .bottom, spacing: -size * 0.12) {
            // 與滑動方向一致：角頭在左、阿正在右
            Critter(kind: .hmm, mood: .worried, size: size)
            Critter(kind: .spark, mood: .celebrate, size: size * 0.85)
                .offset(y: -size * 0.18)
            Critter(kind: .yes, mood: .happy, size: size)
        }
    }
}

// MARK: - 繪製

private struct SeededRNG {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed &* 2_654_435_761 &+ 1
        if state == 0 { state = 1 }
    }

    mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }

    mutating func range(_ low: CGFloat, _ high: CGFloat) -> CGFloat {
        let unit = CGFloat(Double(next() >> 11) / Double(1 << 53))
        return low + (high - low) * unit
    }
}

private struct CritterPainter {
    let context: GraphicsContext
    let scale: CGFloat
    var rng: SeededRNG

    /// 臉上的線條固定用深墨色（畫在彩色身體上）
    private let faceInk = Color(light: 0x161616, dark: 0x161616)
    /// 身體外的記號跟著主題切換
    private let looseInk = Palette.ink

    init(context: GraphicsContext, scale: CGFloat, seed: UInt64) {
        self.context = context
        self.scale = scale
        self.rng = SeededRNG(seed: seed)
    }

    // MARK: 角色

    mutating func draw(kind: CritterKind, mood: CritterMood, blinking: Bool) {
        let color = kind.color
        let eyesClosed = mood == .sleepy || blinking

        switch kind {
        case .yes:
            paper([(37, 76), (45, 76), (45, 95), (37, 95)], color, jitter: 0.8)
            paper([(56, 76), (64, 76), (64, 95), (56, 95)], color, jitter: 0.8)
            if mood == .happy || mood == .celebrate {
                limb((33, 42), (16, 14), color, width: 8)
                limb((69, 42), (86, 14), color, width: 8)
                paper([(10, 6), (22, 6), (22, 17), (10, 17)], color, jitter: 1)
                paper([(80, 6), (92, 6), (92, 17), (80, 17)], color, jitter: 1)
            } else {
                limb((32, 44), (20, 66), color, width: 8)
                limb((70, 44), (82, 66), color, width: 8)
            }
            paper([(29, 16), (73, 14), (75, 80), (27, 79)], color, jitter: 1.8)

            eyes(left: (44, 37), right: (58, 37), closed: eyesClosed)
            switch mood {
            case .happy, .celebrate:
                openMouth(from: (40, 47), to: (62, 47), depth: 62)
            case .worried:
                marker([(42, 52), (46, 49), (50, 52), (54, 49), (58, 52)])
            case .sleepy:
                marker([(47, 51), (55, 51)])
            default:
                markerCurve(from: (42, 49), control: (51, 56), to: (60, 48))
            }

        case .hmm:
            paper([(34, 80), (42, 80), (42, 94), (34, 94)], color, jitter: 0.8)
            paper([(58, 80), (66, 80), (66, 94), (58, 94)], color, jitter: 0.8)
            if mood == .happy || mood == .celebrate {
                limb((24, 64), (10, 44), color, width: 7)
                limb((78, 64), (92, 44), color, width: 7)
            }
            paper([(14, 84), (30, 40), (52, 14), (74, 38), (88, 84)], color, jitter: 2)

            switch mood {
            case .thinking:
                limb((70, 62), (62, 48), color, width: 7)
                marker([(40, 40), (47, 40)])
                marker([(55, 40), (62, 40)])
                markerCurve(from: (44, 56), control: (51, 53), to: (58, 56))
                dot((84, 22), 2, looseInk)
                dot((90, 12), 3, looseInk)
            case .worried:
                dashEyes()
                marker([(38, 33), (47, 35)])
                marker([(55, 35), (64, 32)])
                marker([(40, 57), (44, 53), (48, 57), (52, 53), (56, 57), (60, 53)])
            case .happy, .celebrate:
                dashEyes()
                openMouth(from: (41, 52), to: (61, 52), depth: 64)
            default:
                dashEyes()
                marker([(43, 56), (59, 55)])
            }

        case .spark:
            var points: [(CGFloat, CGFloat)] = []
            for index in 0..<16 {
                let angle = (-90 + CGFloat(index) * 22.5) * .pi / 180
                let radius: CGFloat = index.isMultiple(of: 2) ? 38 : 22
                points.append((50 + radius * cos(angle), 52 + radius * sin(angle)))
            }
            paper(points, color, jitter: 1.4)

            eyes(left: (44, 47), right: (57, 47), closed: eyesClosed)
            switch mood {
            case .happy, .celebrate:
                openMouth(from: (42, 56), to: (59, 56), depth: 68)
            case .sleepy:
                marker([(46, 60), (55, 60)])
            default:
                markerCurve(from: (44, 58), control: (50.5, 63), to: (57, 58))
            }
            if mood == .celebrate {
                for ray in [((8, 20), (14, 26)), ((92, 20), (86, 26)), ((6, 70), (13, 68)), ((94, 70), (87, 68)), ((50, 2), (50, 8))] as [((CGFloat, CGFloat), (CGFloat, CGFloat))] {
                    marker([ray.0, ray.1], color: looseInk)
                }
            }
        }
    }

    // MARK: 筆觸工具

    private func pt(_ p: (CGFloat, CGFloat)) -> CGPoint {
        CGPoint(x: p.0 * scale, y: p.1 * scale)
    }

    /// 手剪紙片：頂點抖動、邊緣分段，並疊上蠟筆紋理
    private mutating func paper(_ points: [(CGFloat, CGFloat)], _ color: Color, jitter: CGFloat) {
        var rough: [CGPoint] = []
        for index in points.indices {
            let a = points[index]
            let b = points[(index + 1) % points.count]
            for step in 0..<3 {
                let t = CGFloat(step) / 3
                rough.append(pt((
                    a.0 + (b.0 - a.0) * t + rng.range(-jitter, jitter),
                    a.1 + (b.1 - a.1) * t + rng.range(-jitter, jitter)
                )))
            }
        }
        var path = Path()
        path.addLines(rough)
        path.closeSubpath()
        context.fill(path, with: .color(color))
        crayonTexture(in: path)
    }

    private mutating func crayonTexture(in path: Path) {
        let box = path.boundingRect
        let area = box.width * box.height / (scale * scale)
        let count = max(12, Int(area / 28))
        var strokes: [(CGPoint, CGPoint, Bool, CGFloat)] = []
        for index in 0..<count {
            let center = CGPoint(x: rng.range(box.minX, box.maxX), y: rng.range(box.minY, box.maxY))
            let length = rng.range(3, 9) * scale
            let angle = (-60 + rng.range(-12, 12)) * .pi / 180
            let dx = cos(angle) * length / 2
            let dy = sin(angle) * length / 2
            strokes.append((
                CGPoint(x: center.x - dx, y: center.y - dy),
                CGPoint(x: center.x + dx, y: center.y + dy),
                index % 3 == 0,
                rng.range(0.5, 1.1) * scale
            ))
        }
        context.drawLayer { layer in
            layer.clip(to: path)
            for stroke in strokes {
                var line = Path()
                line.move(to: stroke.0)
                line.addLine(to: stroke.1)
                let tone: Color = stroke.2 ? .white.opacity(0.22) : .black.opacity(0.17)
                layer.stroke(line, with: .color(tone), style: StrokeStyle(lineWidth: stroke.3, lineCap: .round))
            }
        }
    }

    private func limb(_ from: (CGFloat, CGFloat), _ to: (CGFloat, CGFloat), _ color: Color, width: CGFloat) {
        var path = Path()
        path.move(to: pt(from))
        path.addLine(to: pt(to))
        context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width * scale, lineCap: .square))
    }

    private func marker(_ points: [(CGFloat, CGFloat)], width: CGFloat = 3, color: Color? = nil) {
        var path = Path()
        path.addLines(points.map(pt))
        context.stroke(path, with: .color(color ?? faceInk), style: StrokeStyle(lineWidth: width * scale, lineCap: .round, lineJoin: .round))
    }

    private func markerCurve(from: (CGFloat, CGFloat), control: (CGFloat, CGFloat), to: (CGFloat, CGFloat)) {
        var path = Path()
        path.move(to: pt(from))
        path.addQuadCurve(to: pt(to), control: pt(control))
        context.stroke(path, with: .color(faceInk), style: StrokeStyle(lineWidth: 3 * scale, lineCap: .round))
    }

    private func openMouth(from: (CGFloat, CGFloat), to: (CGFloat, CGFloat), depth: CGFloat) {
        var path = Path()
        path.move(to: pt(from))
        path.addQuadCurve(to: pt(to), control: pt(((from.0 + to.0) / 2, depth)))
        path.closeSubpath()
        context.fill(path, with: .color(faceInk))
    }

    private func eyes(left: (CGFloat, CGFloat), right: (CGFloat, CGFloat), closed: Bool) {
        for eye in [left, right] {
            if closed {
                markerCurve(from: (eye.0 - 4, eye.1), control: (eye.0, eye.1 + 3.5), to: (eye.0 + 4, eye.1))
            } else {
                let rect = CGRect(x: (eye.0 - 2.25) * scale, y: (eye.1 - 2.8) * scale, width: 4.5 * scale, height: 5.6 * scale)
                context.fill(Path(ellipseIn: rect), with: .color(faceInk))
            }
        }
    }

    /// 角頭的一字瞇眼
    private func dashEyes() {
        marker([(40, 42), (46, 42)])
        marker([(56, 42), (62, 42)])
    }

    private func dot(_ center: (CGFloat, CGFloat), _ radius: CGFloat, _ color: Color) {
        let rect = CGRect(x: (center.0 - radius) * scale, y: (center.1 - radius) * scale, width: radius * 2 * scale, height: radius * 2 * scale)
        context.fill(Path(ellipseIn: rect), with: .color(color))
    }
}

#Preview {
    VStack(spacing: 24) {
        HStack {
            Critter(kind: .yes, mood: .idle, size: 100)
            Critter(kind: .yes, mood: .happy, size: 100)
            Critter(kind: .hmm, mood: .worried, size: 100)
        }
        HStack {
            Critter(kind: .hmm, mood: .thinking, size: 100)
            Critter(kind: .spark, mood: .sleepy, size: 100)
            Critter(kind: .spark, mood: .celebrate, size: 100)
        }
        CritterGang(size: 100)
    }
    .padding()
    .background(Palette.background)
}
