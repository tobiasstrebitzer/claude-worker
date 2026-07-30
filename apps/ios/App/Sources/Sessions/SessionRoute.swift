import Foundation

/// Everything reachable from the session list's navigation stack.
enum SessionRoute: Hashable {
  case session(String)
  case create(CreateSessionSeed)
}

/// Pre-fill for the create form. Carries only what a caller can know up front —
/// the Resume tab supplies both fields, the "+" button neither.
struct CreateSessionSeed: Hashable {
  var cwd: String = ""
  /// SDK session id to resume (`CreateSessionRequest.resume`).
  var resume: String?
}
