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
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class LiFlowApplianceSigningModule : Module() {
  private val continuityAlias = "jp.jphacks.tkb2633.appliance-signing-v1"
  private val attestedAlias = "jp.jphacks.tkb2633.appliance-attestation-v1"

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun generate(alias: String, challenge: ByteArray? = null) {
    val params = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .apply { if (challenge != null) setAttestationChallenge(challenge) }
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
      .apply { initialize(params) }.generateKeyPair()
  }

  @Suppress("DEPRECATION")
  private fun hardwareKey(store: KeyStore, alias: String): KeyStore.PrivateKeyEntry {
    val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry ?: error("Device signing key unavailable")
    val info = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
      .getKeySpec(entry.privateKey, KeyInfo::class.java)
    check(info.isInsideSecureHardware) { "Hardware-backed device signing unavailable" }
    return entry
  }

  @Synchronized
  private fun continuityKey(): KeyStore.PrivateKeyEntry {
    val store = keyStore()
    if (!store.containsAlias(continuityAlias)) generate(continuityAlias)
    return hardwareKey(store, continuityAlias)
  }

  @Synchronized
  private fun attest(challenge: String): Map<String, Any> {
    require(challenge.length in 1..2048)
    val store = keyStore()
    val hash = MessageDigest.getInstance("SHA-256").digest(challenge.toByteArray(Charsets.UTF_8))
    generate(attestedAlias, hash)
    val entry = hardwareKey(store, attestedAlias)
    return mapOf(
      "publicKey" to encode(entry.certificate.publicKey.encoded),
      "certificateChain" to entry.certificateChain.map { encode(it.encoded) },
    )
  }

  private fun encode(value: ByteArray) = Base64.encodeToString(value, Base64.NO_WRAP)

  private fun sign(message: String, key: KeyStore.PrivateKeyEntry): String {
    require(message.length in 1..4096)
    val signature = Signature.getInstance("SHA256withECDSA").apply {
      initSign(key.privateKey)
      update(message.toByteArray(Charsets.UTF_8))
    }
    return encode(signature.sign())
  }

  override fun definition() = ModuleDefinition {
    Name("LiFlowApplianceSigning")

    AsyncFunction("publicKey") {
      encode(continuityKey().certificate.publicKey.encoded)
    }

    AsyncFunction("sign") { message: String ->
      sign(message, continuityKey())
    }

    AsyncFunction("attestedPublicKey") {
      keyStore().getCertificate(attestedAlias)?.publicKey?.encoded?.let(::encode)
    }

    AsyncFunction("attestKey") { challenge: String ->
      attest(challenge)
    }

    AsyncFunction("signAttested") { message: String ->
      sign(message, hardwareKey(keyStore(), attestedAlias))
    }
  }
}
