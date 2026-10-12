import SwiftUI

/// 關於生活盲盒：為什麼要玩無聊的小事、什麼是懂活、三兄弟、玩法與外觀設定。
/// 版面沿用 Catch-22 順心堂的「關於順心堂」。
struct AboutView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppAppearance.storageKey) private var appearanceRaw = AppAppearance.system.rawValue
    @AppStorage(SoundFX.storageKey) private var soundEnabled = true
    @State private var showingOnboarding = false

    private var version: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(short)（\(build)）"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PageBackground(intensity: 0.8)

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        hero

                        section(
                            title: "為什麼是盲盒？",
                            text: "覺得無聊、提不起勁，或腦袋一直轉停不下來的時候，最難的往往是「決定要做什麼」。所以我們直接幫你決定：抽一個，照著做，就好。"
                        )

                        section(
                            title: "什麼是懂活？",
                            text: "懂活不是把日子過得很滿，而是在很普通的一天裡，也能發現一點點好。摸一下樹皮、聞一下茶香，世界沒有變，但你會鬆一點。耍廢沒關係，沒有生產力的時間，正是讓生活抱抱你的時間。"
                        )

                        VStack(alignment: .leading, spacing: 14) {
                            Text("堂口成員")
                                .font(.headline.weight(.black))
                                .foregroundStyle(Palette.ink)
                            ForEach([CritterKind.yes, .hmm, .spark], id: \.name) { kind in
                                member(kind)
                            }
                        }
                        .softCard(seed: 2)

                        VStack(alignment: .leading, spacing: 14) {
                            Text("怎麼玩")
                                .font(.headline.weight(.black))
                                .foregroundStyle(Palette.ink)
                            step(Palette.pro, "抽一個", "不想玩就換一個，換幾次都行；想走就按左上的「收起來」。")
                            step(Palette.con, "做一件小事", "每張只有一件事，最後拍一張、錄一段聲音或影片。")
                            step(Palette.sun, "寫一句", "想寫就寫剛剛的感覺，寫爛也沒人看。")
                            step(Palette.mint, "收進收藏", "一週一面拍立得牆，累的時候回來看看。")
                        }
                        .softCard(seed: 3)

                        section(
                            title: "盒規只有一條",
                            text: "沒有連續紀錄、沒有扣分，也沒有人在檢查。今天不想玩，就是今天的玩法；今天只想耍廢，也是。"
                        )

                        appearancePicker

                        Button("重看開箱介紹") { showingOnboarding = true }
                            .buttonStyle(.paper)

                        credit
                    }
                    .padding(20)
                }
            }
            .navigationTitle("關於生活盲盒")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .fullScreenCover(isPresented: $showingOnboarding) {
            OnboardingView { showingOnboarding = false }
        }
        // sheet 是獨立的呈現層，要自己套用外觀，切換時才會立刻生效
        .appAppearance()
    }

    // MARK: - 區塊

    private var hero: some View {
        VStack(spacing: 12) {
            CritterGang(size: 100)
                .frame(height: 160)

            Text(Story.appName)
                .font(.largeTitle.weight(.black))
                .foregroundStyle(Palette.ink)
            Text("\(Story.gangName)出品")
                .font(.title3.weight(.black))
                .foregroundStyle(Palette.onAccent)
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
                .background(Palette.accent, in: PaperShape(seed: 91, wobble: 1.5))
            Text(Story.motto)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func section(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline.weight(.black))
                .foregroundStyle(Palette.ink)
            Text(text)
                .font(.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
        }
        .softCard(seed: title.count)
    }

    private func member(_ kind: CritterKind) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Critter(kind: kind, mood: .happy, size: 60)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(kind.name)
                        .font(.headline.weight(.black))
                        .foregroundStyle(Palette.ink)
                    Text(kind.role)
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(kind.onColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(kind.color, in: PaperShape(seed: 92, wobble: 1))
                }
                Text(kind.introduction)
                    .font(.footnote)
                    .foregroundStyle(Palette.inkSoft)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func step(_ color: Color, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            PaperShape(seed: title.count, wobble: 1.5)
                .fill(color)
                .frame(width: 16, height: 16)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(Palette.ink)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Palette.inkSoft)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var appearancePicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("外觀與音效")
                .font(.headline.weight(.black))
                .foregroundStyle(Palette.ink)
            Picker("外觀", selection: $appearanceRaw) {
                ForEach(AppAppearance.allCases) { option in
                    Text(option.title).tag(option.rawValue)
                }
            }
            .pickerStyle(.segmented)

            Toggle("音效", isOn: $soundEnabled)
                .font(.subheadline.weight(.bold))
                .tint(Palette.pro)
        }
        .softCard(seed: 4)
    }

    private var credit: some View {
        VStack(spacing: 6) {
            Text("Kind of wisdom, kind of love.")
                .font(.footnote.weight(.heavy))
                .italic()
                .foregroundStyle(Palette.ink)
            Text("有種智慧實驗室")
                .font(.footnote.weight(.heavy))
                .foregroundStyle(Palette.ink)
            Text("版本 \(version)")
                .font(.caption2)
                .foregroundStyle(Palette.inkSoft)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

#Preview {
    AboutView()
}
