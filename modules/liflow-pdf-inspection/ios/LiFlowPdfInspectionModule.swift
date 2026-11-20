import Dispatch
import ExpoModulesCore
import Foundation
import PDFKit

public final class LiFlowPdfInspectionModule: Module {
  private let inspectionQueue = DispatchQueue(label: "liflow.pdf-inspection", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("LiFlowPdfInspection")

    AsyncFunction("pageCount") { (uri: String) -> Int in
      guard let url = URL(string: uri), url.isFileURL,
            let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
        return 0
      }

      let file = url.standardizedFileURL.resolvingSymlinksInPath()
      let cachePath = cache.standardizedFileURL.resolvingSymlinksInPath().path
      guard file.path.hasPrefix(cachePath + "/"),
            let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true, let size = values.fileSize, (32...6 * 1024 * 1024).contains(size),
            let pdf = PDFDocument(url: file), !pdf.isLocked else {
        return 0
      }
      return pdf.pageCount
    }.runOnQueue(inspectionQueue)
  }
}
