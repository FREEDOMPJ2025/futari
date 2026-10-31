import AppIntents
import UIKit

// #1823 「Futari 記一筆」App Intent. Opens Futari's own quick-add deep link
// (`dev.southernlight.futari://add?...`); every check (amount range, pickable category,
// note sanitising) stays in lib/quickAdd.ts on the web side. This file only builds the URL.
// Never log amount / note: they are user data.
//
// #1878 Localization: the literals below are English *keys* into App/Localizable.xcstrings
// (en, zh-Hant, zh-Hans, ja). Edit translations there, not here. Languages the catalog does not
// cover fall back to the development region (en). An interpolated `Summary` key reads
// "Add ${amount} to Futari" in the catalog.

// The 9 pickable ids from lib/categories.ts (everything except `settle`).
@available(iOS 16.0, *)
enum QuickAddCategory: String, AppEnum {
    case dining, clothing, housing, transit, education, entertainment, health, financial, other

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Category"
    static var caseDisplayRepresentations: [QuickAddCategory: DisplayRepresentation] = [
        .dining: "Dining",
        .clothing: "Clothing",
        .housing: "Housing",
        .transit: "Transit",
        .education: "Education",
        .entertainment: "Entertainment",
        .health: "Health",
        .financial: "Financial",
        .other: "Other",
    ]
}

@available(iOS 16.0, *)
struct QuickAddIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Entry to Futari"
    static var description = IntentDescription("Opens Futari's Add entry screen with the amount, note and category filled in.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Amount")
    var amount: Double

    @Parameter(title: "Note")
    var note: String?

    @Parameter(title: "Category")
    var category: QuickAddCategory?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$amount) to Futari") {
            \.$note
            \.$category
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        var items: [URLQueryItem] = []
        // Non-finite, absurdly large amounts or ones that round to 0 are left out so the web
        // leaves the field blank; Int(_:) would trap on values beyond Int range.
        let rounded = amount.rounded()
        if amount.isFinite, rounded >= 1, rounded < 1e15 {
            items.append(URLQueryItem(name: "amount", value: String(Int(rounded))))
        }
        if let note, !note.isEmpty { items.append(URLQueryItem(name: "note", value: note)) }
        if let category { items.append(URLQueryItem(name: "category", value: category.rawValue)) }

        var components = URLComponents()
        components.scheme = "dev.southernlight.futari"
        components.host = "add"
        components.queryItems = items.isEmpty ? nil : items
        // URLComponents leaves `+` as is, but lib/quickAdd.ts reads the query with
        // URLSearchParams, which decodes `+` as a space ("Disney+" would arrive as "Disney").
        // Every literal `+` here comes from a value, since the names are fixed.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        if let url = components.url {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}
