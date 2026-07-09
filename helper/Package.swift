// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "notes-ax-helper",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "notes-ax-helper",
      path: "Sources/notes-ax-helper",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
