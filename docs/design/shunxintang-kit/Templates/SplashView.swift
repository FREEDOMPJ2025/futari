import SwiftUI

/// 品牌開場（約 2 秒）：畫面正中央，角頭、阿和、阿正輕輕彈出來，一起跳一下。
/// 生活盲盒版在三兄弟下方加了 App 名稱，可參考。
struct SplashView: View {
    @State private var shown = [false, false, false]
    @State private var hop = false

    private let kinds: [CritterKind] = [.hmm, .spark, .yes]

    var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()

            HStack(alignment: .bottom, spacing: 4) {
                ForEach(kinds.indices, id: \.self) { index in
                    Critter(kind: kinds[index], mood: hop ? .celebrate : .happy, size: 56)
                        .scaleEffect(shown[index] ? 1 : 0.2, anchor: .bottom)
                        .opacity(shown[index] ? 1 : 0)
                        .offset(y: hop ? (index == 1 ? -12 : -8) : 0)
                }
            }
        }
        .task { await play() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Story.gangName) \(Story.appName)")
    }

    private func play() async {
        try? await Task.sleep(for: .seconds(0.15))
        for index in kinds.indices {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.55)) { shown[index] = true }
            try? await Task.sleep(for: .seconds(0.14))
        }
        try? await Task.sleep(for: .seconds(0.45))
        withAnimation(.spring(response: 0.22, dampingFraction: 0.5)) { hop = true }
        try? await Task.sleep(for: .seconds(0.22))
        withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { hop = false }
    }
}

#Preview {
    SplashView()
}
