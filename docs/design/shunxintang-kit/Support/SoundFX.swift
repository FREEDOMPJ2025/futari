import AudioToolbox
import Foundation

/// 音效：沿用順心堂的做法，用 iPhone 內建系統音效，會跟著靜音開關，也能在選單關閉。
final class SoundFX {
    static let shared = SoundFX()
    static let storageKey = "soundEnabled"

    enum Effect {
        /// 盲盒晃動：短促的「Tink」
        case tick
        /// 卡片跳出、換一個：輕盈的「Tock」
        case pop
        /// 收進盲盒：像寄出信件的「咻」
        case send
        /// 拍立得顯影完成：清脆舒緩的「Bloom」
        case bloom

        /// iPhone 內建系統音效 ID，想換聲音改這裡就好
        var systemSoundID: SystemSoundID {
            switch self {
            case .tick: 1103
            case .pop: 1104
            case .send: 1001
            case .bloom: 1021
            }
        }
    }

    private init() {}

    var isEnabled: Bool {
        UserDefaults.standard.object(forKey: Self.storageKey) as? Bool ?? true
    }

    func play(_ effect: Effect) {
        guard isEnabled else { return }
        AudioServicesPlaySystemSound(effect.systemSoundID)
    }
}
