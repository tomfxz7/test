import Foundation

struct ProjectBundle: Codable {
    let type: String
    let exportedAt: Date
    var projects: [Project]

    init(projects: [Project]) {
        self.type = "project-bundle"
        self.exportedAt = Date()
        self.projects = projects
    }
}

struct Project: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var createdAt: Date
    var items: [ReportItem]

    init(id: String = UUID().uuidString, title: String, createdAt: Date = Date(), items: [ReportItem] = []) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.items = items
    }
}

struct ReportItem: Codable, Identifiable, Hashable {
    var id: String
    var memo: String
    var images: [ReportImage]

    init(id: String = UUID().uuidString, memo: String = "", images: [ReportImage] = []) {
        self.id = id
        self.memo = memo
        self.images = images
    }
}

struct ReportImage: Codable, Identifiable, Hashable {
    var id: String
    var imageBase64: String

    init(id: String = UUID().uuidString, imageBase64: String) {
        self.id = id
        self.imageBase64 = imageBase64
    }
}
