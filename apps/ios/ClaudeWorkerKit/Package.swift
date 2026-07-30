// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ClaudeWorkerKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "ClaudeWorkerKit", targets: ["ClaudeWorkerKit"])
  ],
  targets: [
    .target(name: "ClaudeWorkerKit"),
    .testTarget(name: "ClaudeWorkerKitTests", dependencies: ["ClaudeWorkerKit"]),
  ]
)
