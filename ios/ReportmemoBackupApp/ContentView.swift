import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: ProjectStore
    @State private var newTitle: String = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                HStack {
                    TextField("新規プロジェクト名", text: $newTitle)
                        .textFieldStyle(.roundedBorder)
                    Button("追加") {
                        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !title.isEmpty else { return }
                        store.addProject(title: title)
                        newTitle = ""
                    }
                    .buttonStyle(.borderedProminent)
                }

                List {
                    Section("プロジェクト") {
                        ForEach(store.projects) { p in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(p.title).font(.headline)
                                Text("記録項目: \(p.items.count)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .onDelete(perform: store.deleteProjects)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Toggle("自動保存を有効化", isOn: $store.autoSaveEnabled)
                        .onChange(of: store.autoSaveEnabled) { _, _ in store.startAutoSaveTimer() }
                    HStack {
                        Text("間隔: \(Int(store.autoSaveIntervalMinutes))分")
                        Slider(value: $store.autoSaveIntervalMinutes, in: 1...60, step: 1)
                            .onChange(of: store.autoSaveIntervalMinutes) { _, _ in store.startAutoSaveTimer() }
                    }
                    if let lastSavedAt = store.lastSavedAt {
                        Text("最終保存: \(lastSavedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .background(.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))

                HStack {
                    Button("今すぐ保存") {
                        store.saveToDisk()
                    }
                    .buttonStyle(.bordered)

                    ShareLink(item: store.exportFileURL()) {
                        Label("JSONを共有", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding()
            .navigationTitle("Reportmemo iOS")
        }
    }
}
