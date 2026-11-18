package expo.modules.liflowed25519

import expo.modules.kotlin.jni.TypedArrayKind
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.TypedArray

class LiFlowEd25519Module : Module() {
  override fun definition() = ModuleDefinition {
    Name("LiFlowEd25519")

    Constant("version") {
      NativeBridge.version()
    }

    Function("verify") { signature: TypedArray, message: TypedArray, publicKey: TypedArray ->
      if (signature.kind != TypedArrayKind.Uint8Array ||
        message.kind != TypedArrayKind.Uint8Array ||
        publicKey.kind != TypedArrayKind.Uint8Array ||
        signature.byteLength != 64 ||
        publicKey.byteLength != 32
      ) {
        return@Function false
      }

      NativeBridge.verify(
        signature.toDirectBuffer(),
        message.toDirectBuffer(),
        publicKey.toDirectBuffer()
      )
    }
  }
}
