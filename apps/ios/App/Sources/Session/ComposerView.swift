import SwiftUI

/// The input bar: a growing text field, plus send — or stop while a turn is live.
struct ComposerView: View {
  @Binding var text: String
  let isBusy: Bool
  let isEnabled: Bool
  let onSend: () -> Void
  let onStop: () -> Void

  @FocusState private var isFocused: Bool

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message", text: $text, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .focused($isFocused)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        .disabled(!isEnabled)

      if isBusy {
        Button(action: onStop) {
          Image(systemName: "stop.fill")
            .font(.body)
            .frame(width: 34, height: 34)
            .background(Color.secondary.opacity(0.18), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop the current turn")
      }

      Button {
        onSend()
        // Keep the keyboard up: a remote control is used in bursts.
        isFocused = true
      } label: {
        Image(systemName: "arrow.up")
          .font(.body.weight(.semibold))
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(canSend ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
  }

  private var canSend: Bool {
    isEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
