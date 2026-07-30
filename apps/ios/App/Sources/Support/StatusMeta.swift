import ClaudeWorkerKit
import SwiftUI

/// Presentation for `SessionStatus`, mirroring the web dashboard's `STATUS_META`
/// so the two clients read the same at a glance. Semantic colors only, so dark
/// mode and increased contrast come for free.
extension SessionStatus {
  var label: String {
    switch self {
    case .starting: return "Starting"
    case .running: return "Running"
    case .awaitingApproval: return "Needs approval"
    case .idle: return "Idle"
    case .parked: return "Parked"
    case .failed: return "Failed"
    case .closed: return "Closed"
    }
  }

  var tint: Color {
    switch self {
    case .starting, .running: return .blue
    case .awaitingApproval: return .orange
    case .idle: return .green
    case .parked: return .purple
    case .failed: return .red
    case .closed: return .secondary
    }
  }

  /// Whether a turn is in flight — drives the spinner and the stop button.
  var isBusy: Bool {
    switch self {
    case .starting, .running, .awaitingApproval: return true
    case .idle, .parked, .failed, .closed: return false
    }
  }
}

extension PermissionMode {
  var label: String {
    switch self {
    case .default: return "Default"
    case .acceptEdits: return "Accept edits"
    case .bypassPermissions: return "Bypass permissions"
    case .plan: return "Plan"
    case .dontAsk: return "Don't ask"
    case .auto: return "Auto"
    }
  }
}

/// A filled dot + label, used for both the session list rows and the live header.
struct StatusBadge: View {
  let status: SessionStatus
  var pendingCount: Int = 0
  var compact = false

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(status.tint)
        .frame(width: 7, height: 7)
      Text(text)
        .font(compact ? .caption2 : .caption)
        .fontWeight(.medium)
        .foregroundStyle(status == .awaitingApproval ? Color.orange : Color.secondary)
    }
    .padding(.horizontal, compact ? 0 : 6)
    .padding(.vertical, compact ? 0 : 2)
    .background(
      compact
        ? nil
        : Capsule().fill(status.tint.opacity(0.12))
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(text)
  }

  private var text: String {
    if status == .awaitingApproval, pendingCount > 0 {
      return "\(status.label) (\(pendingCount))"
    }
    return status.label
  }
}
