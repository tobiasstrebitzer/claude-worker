import SwiftUI

/// Inline failure banner. A gateway on a tailnet is unreachable far more often
/// than it is broken, so the hint names the usual cause rather than making the
/// user guess from a URLError.
struct ErrorBanner: View {
  let message: String
  var hint: String? = "Check that the server is running and your Tailscale/VPN is connected."
  var retry: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 3) {
        Text(message)
          .font(.footnote)
          .foregroundStyle(.primary)
        if let hint {
          Text(hint)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
      if let retry {
        Button("Retry", action: retry)
          .font(.footnote.weight(.semibold))
          .buttonStyle(.borderless)
      }
    }
    .padding(10)
    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
  }
}
