import SwiftUI

@main
struct ReportmemoBackupApp: App {
    @StateObject private var store = ProjectStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .task {
                    await store.loadFromDisk()
                    store.startAutoSaveTimer()
                }
        }
    }
}
