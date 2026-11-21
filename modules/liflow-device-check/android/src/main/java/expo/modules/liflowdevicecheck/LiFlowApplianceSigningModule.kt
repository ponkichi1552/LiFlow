package expo.modules.liflowdevicecheck

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class LiFlowApplianceSigningModule : Module() {
  private val alias = "jp.jphacks.tkb2633.appliance-signing-v1"

  @Suppress("DEPRECATION")
  @Synchronized
  private fun signingKey(): KeyStore.PrivateKeyEntry {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (!store.containsAlias(alias)) {
      val params = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        .apply { initialize(params) }.generateKeyPair()
    }
    val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry ?: error("Device signing key unavailable")
    val info = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
      .getKeySpec(entry.privateKey, KeyInfo::class.java)
    check(info.isInsideSecureHardware) { "Hardware-backed device signing unavailable" }
    return entry
  }

  override fun definition() = ModuleDefinition {
    Name("LiFlowApplianceSigning")

    AsyncFunction("publicKey") {
      Base64.encodeToString(signingKey().certificate.publicKey.encoded, Base64.NO_WRAP)
    }

    AsyncFunction("sign") { message: String ->
      require(message.length in 1..4096)
      val signature = Signature.getInstance("SHA256withECDSA").apply {
        initSign(signingKey().privateKey)
        update(message.toByteArray(Charsets.UTF_8))
      }
      Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }
  }
}
