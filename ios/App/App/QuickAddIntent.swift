import AppIntents
import UIKit

// #1823 「Futari 記一筆」App Intent. Opens Futari's own quick-add deep link
// (`dev.southernlight.futari://add?...`); every check (amount range, pickable category,
// note sanitising) stays in lib/quickAdd.ts on the web side. This file only builds the URL.
// Never log amount / note: they are user data.

// The 9 pickable ids from lib/categories.ts (everything except `settle`).
@available(iOS 16.0, *)
enum QuickAddCategory: String, AppEnum {
    case dining, clothing, housing, transit, education, entertainment, health, financial, other

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "分類"
    static var caseDisplayRepresentations: [QuickAddCategory: DisplayRepresentation] = [
        .dining: "飲食",
        .clothing: "服飾",
        .housing: "居住",
        .transit: "交通",
        .education: "教育",
        .entertainment: "娛樂",
        .health: "醫療",
        .financial: "金融",
        .other: "其他",
    ]
}

@available(iOS 16.0, *)
struct QuickAddIntent: AppIntent {
    static var title: LocalizedStringResource = "Futari 記一筆"
    static var description = IntentDescription("打開 Futari 的記一筆畫面，帶入金額、備註與分類。")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "金額")
    var amount: Double

    @Parameter(title: "備註")
    var note: String?

    @Parameter(title: "分類")
    var category: QuickAddCategory?

    static var parameterSummary: some ParameterSummary {
        Summary("在 Futari 記一筆 \(\.$amount)") {
            \.$note
            \.$category
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        var items: [URLQueryItem] = []
        // Non-finite, non-positive or absurdly large amounts are left out so the web leaves the
        // field blank; Int(_:) would trap on values beyond Int range.
        if amount.isFinite, amount > 0, amount < 1e15 {
            items.append(URLQueryItem(name: "amount", value: String(Int(amount.rounded()))))
        }
        if let note, !note.isEmpty { items.append(URLQueryItem(name: "note", value: note)) }
        if let category { items.append(URLQueryItem(name: "category", value: category.rawValue)) }

        var components = URLComponents()
        components.scheme = "dev.southernlight.futari"
        components.host = "add"
        components.queryItems = items.isEmpty ? nil : items
        if let url = components.url {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}
