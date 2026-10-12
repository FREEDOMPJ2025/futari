import SwiftUI

/// 開箱介紹：第一次打開時，三兄弟出來打招呼（沿用順心堂「入堂介紹」的節奏）
/// 每頁只有三個重點：角色、名字、一段話。
struct OnboardingView: View {
    var onFinish: () -> Void

    @State private var page = 0
    private let lastPage = 4

    var body: some View {
        ZStack {
            PageBackground()

            VStack(spacing: 16) {
                HStack {
                    Spacer()
                    if page < lastPage {
                        Button("略過") { onFinish() }
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Palette.inkSoft)
                    }
                }
                .frame(height: 32)

                TabView(selection: $page) {
                    introPage.tag(0)
                    memberPage(.yes, mood: .happy).tag(1)
                    memberPage(.hmm, mood: .thinking).tag(2)
                    memberPage(.spark, mood: .celebrate).tag(3)
                    finalePage.tag(4)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                pageDots

                Button(page == lastPage ? "開箱，開始耍廢" : "下一位") {
                    if page == lastPage {
                        onFinish()
                    } else {
                        withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { page += 1 }
                    }
                }
                .buttonStyle(CalmButtonStyle())
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
        }
        .sensoryFeedback(.selection, trigger: page)
    }

    // MARK: - 頁面

    private var introPage: some View {
        VStack(spacing: 22) {
            Spacer()
            CritterGang(size: 100)
                .frame(height: 150)
            Text("有點無聊嗎？")
                .font(.title.weight(.black))
                .foregroundStyle(Palette.ink)
            Text("無聊沒什麼不好。\n順心堂三兄弟開了一攤「生活盲盒」，\n專門陪你做一些更無聊的小事。")
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
                .lineSpacing(5)
            Spacer()
        }
    }

    private func memberPage(_ kind: CritterKind, mood: CritterMood) -> some View {
        VStack(spacing: 18) {
            Spacer()
            Critter(kind: kind, mood: mood, size: 180)

            VStack(spacing: 8) {
                Text(kind.name)
                    .font(.system(size: 44, weight: .black))
                    .foregroundStyle(Palette.ink)
                Text("順心堂・\(kind.role)")
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(kind.onColor)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(kind.color, in: PaperShape(seed: 41, wobble: 1.5))
            }

            Text(kind.introduction)
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
                .lineSpacing(5)
                .padding(.horizontal, 8)
            Spacer()
        }
    }

    private var finalePage: some View {
        VStack(spacing: 22) {
            Spacer()
            HStack(alignment: .bottom, spacing: -10) {
                Critter(kind: .hmm, mood: .celebrate, size: 100)
                Critter(kind: .spark, mood: .celebrate, size: 90)
                    .offset(y: -20)
                Critter(kind: .yes, mood: .celebrate, size: 100)
            }
            .frame(height: 150)

            Text("懂活")
                .font(.system(size: 56, weight: .black))
                .foregroundStyle(Palette.ink)
            Text("抽一個、做一件沒用的小事、收進收藏。\n耍廢沒關係，讓生活抱你一下，\n這就叫懂活。")
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
                .lineSpacing(5)
            Spacer()
        }
    }

    private var pageDots: some View {
        HStack(spacing: 8) {
            ForEach(0...lastPage, id: \.self) { index in
                PaperShape(seed: 50 + index, wobble: 1)
                    .fill(index == page ? Palette.ink : Palette.ink.opacity(0.2))
                    .frame(width: index == page ? 22 : 8, height: 8)
                    .animation(.spring(response: 0.3), value: page)
            }
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    OnboardingView {}
}
