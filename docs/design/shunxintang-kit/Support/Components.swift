import SwiftUI
import UIKit

/// 每一頁共用的底：紙色＋邊緣散落的剪紙碎片
struct PageBackground: View {
    var intensity: Double = 1

    var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()
            PlayfulBackground(intensity: intensity)
        }
    }
}

/// 系統分享面板（Instagram、儲存影像、訊息…）
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct ShareImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

enum Haptics {
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}

// MARK: - 日期（固定台灣中文格式、週一開始）

extension Calendar {
    /// 台灣習慣：一週從星期一開始
    static let taiwan: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "zh_Hant_TW")
        calendar.firstWeekday = 2
        return calendar
    }()

    func startOfWeek(for date: Date) -> Date {
        dateInterval(of: .weekOfYear, for: date)?.start ?? startOfDay(for: date)
    }
}

extension Date {
    private static let taiwanLocale = Locale(identifier: "zh_Hant_TW")

    /// 10/9
    var twShort: String { formatted(.dateTime.month(.defaultDigits).day().locale(Self.taiwanLocale)) }
    /// 10月9日
    var twMonthDay: String { formatted(.dateTime.month().day().locale(Self.taiwanLocale)) }
    /// 週四
    var twWeekday: String { formatted(.dateTime.weekday(.abbreviated).locale(Self.taiwanLocale)) }
    /// 10月9日 週四
    var twMonthDayWeekday: String { formatted(.dateTime.month().day().weekday(.abbreviated).locale(Self.taiwanLocale)) }
    /// 下午2:30
    var twTime: String { formatted(.dateTime.hour().minute().locale(Self.taiwanLocale)) }
}
