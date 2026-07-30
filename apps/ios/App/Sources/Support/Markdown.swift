import Foundation

/// Cheap inline markdown for assistant text.
///
/// Only *inline* syntax is interpreted (bold, italic, code spans, links) and
/// whitespace is preserved, so lists, headings and fenced blocks survive as
/// literal text with their original line breaks instead of being flattened into
/// one paragraph. Full block rendering (and syntax highlighting) is a later
/// phase; this keeps the transcript readable with zero dependencies.
enum Markdown {
  static func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }
}
