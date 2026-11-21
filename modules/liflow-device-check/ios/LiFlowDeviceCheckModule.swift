import DeviceCheck
import ExpoModulesCore
import Foundation

public final class LiFlowDeviceCheckModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiFlowDeviceCheck")

    AsyncFunction("generateToken") { () async throws -> String in
      let token = try await DCDevice.current.generateToken()
      return token.base64EncodedString()
    }
  }
}
