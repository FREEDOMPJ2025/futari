import SwiftUI

// MARK: - 順心堂系列：世界觀（每個 App 改這裡）

/// 順心堂：三兄弟開的堂口。每個 App 是堂口開的一攤新生意，
/// 例如 Catch-22（兩難時喬事）、生活盲盒（無聊時玩更無聊的小事）。
enum Story {
    static let gangName = "順心堂"
    /// ⬇︎ 換成新 App 的名字與一句話標語
    static let appName = "新 App 名稱"
    static let motto = "一句話說出這攤在做什麼。"
}

struct StoryLine: Equatable {
    let speaker: CritterKind
    let text: String
}

// MARK: - 三兄弟（名字與造型固定；擔當可依 App 調整）

extension CritterKind {
    var name: String {
        switch self {
        case .yes: "阿正"
        case .hmm: "角頭"
        case .spark: "阿和"
        }
    }

    /// 在這個 App 裡的分工。
    /// Catch-22：衝鋒／把關／和事佬；生活盲盒：動手／眼力／陪伴
    var role: String {
        switch self {
        case .yes: "衝鋒擔當"
        case .hmm: "把關擔當"
        case .spark: "和事佬"
        }
    }

    var introduction: String {
        switch self {
        case .yes: "個性直、衝第一。"
        case .hmm: "話不多、眼很利。"
        case .spark: "堂口的和事佬，最會陪人。"
        }
    }

    /// 放在角色色塊上的文字顏色（黃色底配深色字，其他配白字）
    var onColor: Color {
        self == .spark ? Palette.fixedInk : Palette.fixedPaper
    }
}

// MARK: - 對話泡泡

/// 角色說話：小角色＋名牌＋剪紙泡泡（平貼、無錯位陰影）
struct SpeechBubble: View {
    let line: StoryLine
    var mood: CritterMood = .happy
    var critterSize: CGFloat = 52
    var animatedCritter = true

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Critter(kind: line.speaker, mood: mood, size: critterSize, animated: animatedCritter)

            VStack(alignment: .leading, spacing: 4) {
                Text(line.speaker.name)
                    .font(.caption.weight(.black))
                    .foregroundStyle(line.speaker.onColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(line.speaker.color, in: PaperShape(seed: 31, wobble: 1))
                Text(line.text)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                PaperShape(seed: 33, wobble: 1.5)
                    .fill(Palette.surface)
                    .overlay(PaperShape(seed: 33, wobble: 1.5).stroke(Palette.hairline, lineWidth: 1.2))
            )
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(line.speaker.name)說：\(line.text)")
    }
}
