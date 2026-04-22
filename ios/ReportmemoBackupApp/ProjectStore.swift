import Foundation
import SwiftUI

@MainActor
final class ProjectStore: ObservableObject {
    @Published var projects: [Project] = []
    @Published var autoSaveEnabled: Bool = true
    @Published var autoSaveIntervalMinutes: Double = 5
    @Published var lastSavedAt: Date?

    private let fm = FileManager.default
    private var timer: Timer?

    private var docsDirectory: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private var appDataURL: URL {
        docsDirectory.appendingPathComponent("reportmemo_data.json")
    }

    func loadFromDisk() async {
        guard fm.fileExists(atPath: appDataURL.path) else { return }
        do {
            let data = try Data(contentsOf: appDataURL)
            let bundle = try JSONDecoder.app.decode(ProjectBundle.self, from: data)
            self.projects = bundle.projects
        } catch {
            print("load failed: \(error)")
        }
    }

    func saveToDisk() {
        let bundle = ProjectBundle(projects: projects)
        do {
            let data = try JSONEncoder.pretty.encode(bundle)
            try data.write(to: appDataURL, options: .atomic)
            lastSavedAt = Date()
        } catch {
            print("save failed: \(error)")
        }
    }

    func startAutoSaveTimer() {
        timer?.invalidate()
        guard autoSaveEnabled else { return }
        timer = Timer.scheduledTimer(withTimeInterval: max(60, autoSaveIntervalMinutes * 60), repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.saveToDisk()
            }
        }
    }

    func addProject(title: String) {
        projects.append(Project(title: title))
        saveToDisk()
    }

    func deleteProjects(at offsets: IndexSet) {
        projects.remove(atOffsets: offsets)
        saveToDisk()
    }

    func exportFileURL() -> URL {
        saveToDisk()
        return appDataURL
    }
}

enum JSONEncoder {
    static var pretty: Foundation.JSONEncoder {
        let encoder = Foundation.JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var app: Foundation.JSONDecoder {
        let decoder = Foundation.JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
