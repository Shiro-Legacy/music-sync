import ExpoModulesCore

public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    // Marks a file or directory as excluded from iCloud/iTunes backup.
    // Accepts a plain filesystem path. Returns true on success.
    Function("setExcludedFromBackup") { (path: String) -> Bool in
      var url = URL(fileURLWithPath: path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try url.setResourceValues(values)
        return true
      } catch {
        return false
      }
    }
  }
}
