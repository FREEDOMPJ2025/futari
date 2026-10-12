import SwiftUI

// MARK: - 基本幾何形狀

struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct HalfCircle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let radius = min(rect.width / 2, rect.height)
        let center = CGPoint(x: rect.midX, y: rect.maxY)
        path.addArc(center: center, radius: radius, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        path.closeSubpath()
        return path
    }
}

enum GeoKind: Int, CaseIterable {
    case circle, square, triangle, halfCircle, pill

    /// 由 UUID 決定形狀，讓每個念頭都有自己的「小積木」
    static func from(_ id: UUID) -> GeoKind {
        let value = id.uuid.0 ^ id.uuid.7 ^ id.uuid.15
        return GeoKind(rawValue: Int(value) % GeoKind.allCases.count) ?? .circle
    }
}

struct GeoShape: View {
    let kind: GeoKind
    let color: Color
    var size: CGFloat = 16

    var body: some View {
        Group {
            switch kind {
            case .circle:
                Circle().fill(color)
            case .square:
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous).fill(color)
            case .triangle:
                Triangle().fill(color)
            case .halfCircle:
                HalfCircle().fill(color).frame(height: size * 0.55).frame(height: size, alignment: .bottom)
            case .pill:
                Capsule().fill(color).frame(height: size * 0.5)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - 背景點點幾何

/// 散落在背景的淡淡幾何圖案，帶來一點童趣。位置固定，不會分散注意力。
struct PlayfulBackground: View {
    var intensity: Double = 1

    /// 貼在畫面邊緣的剪紙碎片（位置為 0...1 的比例）
    private struct Scrap {
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
        let rotation: Double
        let colorIndex: Int
        let seed: Int
    }

    private static let scraps: [Scrap] = [
        Scrap(x: -0.02, y: 0.32, width: 40, height: 26, rotation: -14, colorIndex: 2, seed: 11),
        Scrap(x: 1.02,  y: 0.22, width: 40, height: 58, rotation: 9,   colorIndex: 1, seed: 12),
        Scrap(x: 0.98,  y: 0.60, width: 30, height: 30, rotation: 24,  colorIndex: 3, seed: 13),
        Scrap(x: 0.01,  y: 0.70, width: 26, height: 44, rotation: -8,  colorIndex: 0, seed: 14),
        Scrap(x: 0.62,  y: 1.00, width: 60, height: 24, rotation: 5,   colorIndex: 4, seed: 15)
    ]

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                // 粉筆灰：細小的紙屑與墨點
                Canvas { context, size in
                    for index in 0..<70 {
                        let fx = fract(Double(index) * 0.618_034 + 0.13)
                        let fy = fract(Double(index) * 0.754_877 + 0.29)
                        // 讓碎屑集中在左右兩側，中間保持乾淨
                        let edgeX = fx < 0.5 ? fx * 0.36 : 1 - (1 - fx) * 0.36
                        let point = CGPoint(x: size.width * edgeX, y: size.height * fy)
                        let side = CGFloat(1.5 + fract(Double(index) * 0.37) * 3.5)
                        let rect = CGRect(x: point.x, y: point.y, width: side, height: side * 0.8)
                        context.fill(
                            Path(rect),
                            with: .color(Palette.ink.opacity(index % 4 == 0 ? 0.35 : 0.18))
                        )
                    }
                }

                ForEach(Self.scraps.indices, id: \.self) { index in
                    let scrap = Self.scraps[index]
                    PaperShape(seed: scrap.seed, wobble: 3)
                        .fill(Palette.playful[scrap.colorIndex % Palette.playful.count])
                        .frame(width: scrap.width, height: scrap.height)
                        .rotationEffect(.degrees(scrap.rotation))
                        .position(x: proxy.size.width * scrap.x, y: proxy.size.height * scrap.y)
                }
            }
        }
        .opacity(0.55 * intensity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .ignoresSafeArea()
    }

    private func fract(_ value: Double) -> Double {
        value - floor(value)
    }
}

// MARK: - 慶祝用的幾何彩紙

/// 每次 `trigger` 改變，就從中心噴出一小把幾何彩紙。
struct ShapeBurst: View {
    var trigger: Int
    var colors: [Color] = Palette.playful
    var count: Int = 14

    private struct Piece: Identifiable {
        let id = UUID()
        let kind: GeoKind
        let color: Color
        let angle: Double
        let distance: CGFloat
        let size: CGFloat
        let spin: Double
    }

    @State private var pieces: [Piece] = []
    @State private var launched = false

    var body: some View {
        ZStack {
            ForEach(pieces) { piece in
                PaperShape(seed: Int(piece.spin), wobble: 1.5)
                    .fill(piece.color)
                    .frame(width: piece.size, height: piece.size * 0.7)
                    .rotationEffect(.degrees(launched ? piece.spin : 0))
                    .offset(
                        x: launched ? CGFloat(cos(piece.angle)) * piece.distance : 0,
                        y: launched ? CGFloat(sin(piece.angle)) * piece.distance : 0
                    )
                    .scaleEffect(launched ? 1 : 0.2)
                    .opacity(launched ? 0 : 1)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: trigger) { _, _ in fire() }
    }

    private func fire() {
        launched = false
        pieces = (0..<count).map { index in
            Piece(
                kind: GeoKind.allCases.randomElement() ?? .circle,
                color: colors[index % colors.count],
                angle: Double(index) / Double(count) * .pi * 2 + Double.random(in: -0.25...0.25),
                distance: CGFloat.random(in: 70...150),
                size: CGFloat.random(in: 9...16),
                spin: Double.random(in: -200...200)
            )
        }
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.9)) {
                launched = true
            }
        }
    }
}
