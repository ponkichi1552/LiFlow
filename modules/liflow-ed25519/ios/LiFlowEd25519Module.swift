import ExpoModulesCore
import Foundation

public final class LiFlowEd25519Module: Module {
  public func definition() -> ModuleDefinition {
    Name("LiFlowEd25519")

    Constant("version") {
      String(cString: lf_ed25519_version())
    }

    Function("verify") { (signature: Data, message: Data, publicKey: Data) -> Bool in
      guard signature.count == 64, publicKey.count == 32 else {
        return false
      }

      return signature.withUnsafeBytes { signatureBytes in
        publicKey.withUnsafeBytes { publicKeyBytes in
          message.withUnsafeBytes { messageBytes in
            lf_ed25519_verify(
              signatureBytes.bindMemory(to: UInt8.self).baseAddress,
              signature.count,
              messageBytes.bindMemory(to: UInt8.self).baseAddress,
              message.count,
              publicKeyBytes.bindMemory(to: UInt8.self).baseAddress,
              publicKey.count
            ) == 1
          }
        }
      }
    }
  }
}
