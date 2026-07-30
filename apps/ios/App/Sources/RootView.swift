import SwiftUI

/// Root: the selected host's session list, or the host manager when there is no
/// selection yet.
struct RootView: View {
  @Environment(HostStore.self) private var hosts

  var body: some View {
    if let host = hosts.selectedHost {
      HostScope(host: host)
        // A different host is a different world — client, sessions, recents.
        // Keying on the id rebuilds the whole subtree instead of migrating it.
        .id(host.id)
    } else {
      NavigationStack {
        HostListView()
      }
    }
  }
}

/// Owns the `HostContext` for one gateway and hands it to everything below.
private struct HostScope: View {
  @State private var context: HostContext

  init(host: Host) {
    _context = State(initialValue: HostContext(host: host))
  }

  var body: some View {
    SessionListView()
      .environment(context)
  }
}
