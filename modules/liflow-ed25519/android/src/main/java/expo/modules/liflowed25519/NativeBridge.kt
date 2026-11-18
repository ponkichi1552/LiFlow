package expo.modules.liflowed25519

import java.nio.ByteBuffer

object NativeBridge {
  init {
    System.loadLibrary("liflow_ed25519")
  }

  external fun version(): String

  external fun verify(signature: ByteBuffer, message: ByteBuffer, publicKey: ByteBuffer): Boolean
}
