package expo.modules.liflowweathertransport

import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.Proxy
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val MAX_FORECAST_BYTES = 512 * 1024
private val forecastETag = Regex("\"[a-f0-9]{64}\"")

class LiFlowWeatherTransportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LiFlowWeatherTransport")

    AsyncFunction("get") Coroutine { address: String, certificate: String, etag: String? ->
      withContext(Dispatchers.IO) { fetchWeather(address, certificate, etag) }
    }
  }
}

private fun fetchWeather(address: String, certificate: String, etag: String?): Map<String, Any> {
  val url = URL(address)
  require(url.protocol == "https" && url.host.isNotEmpty() && url.userInfo == null && url.query == null && url.ref == null)
  require(certificate.length <= 8_192 && (etag == null || forecastETag.matches(etag)))
  val der = Base64.decode(certificate, Base64.NO_WRAP)
  val x509 = CertificateFactory.getInstance("X.509")
    .generateCertificate(ByteArrayInputStream(der)) as X509Certificate
  x509.checkValidity()
  val anchors = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
    load(null)
    setCertificateEntry("liflow-weather", x509)
  }
  val manager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
    init(anchors)
  }
  val tls = SSLContext.getInstance("TLS").apply { init(null, manager.trustManagers, null) }
  val connection = url.openConnection(Proxy.NO_PROXY) as HttpsURLConnection
  connection.sslSocketFactory = tls.socketFactory
  connection.instanceFollowRedirects = false
  connection.useCaches = false
  connection.connectTimeout = 8_000
  connection.readTimeout = 8_000
  connection.setRequestProperty("Accept", "application/json")
  etag?.let { connection.setRequestProperty("If-None-Match", it) }
  try {
    val status = connection.responseCode
    if (status != 200) return mapOf("status" to status)
    if (connection.contentLength > MAX_FORECAST_BYTES) throw IOException("Weather response is too large")
    val result = ByteArrayOutputStream()
    val buffer = ByteArray(8_192)
    val deadline = System.nanoTime() + 10_000_000_000L
    connection.inputStream.use { input ->
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (result.size() + count > MAX_FORECAST_BYTES || System.nanoTime() >= deadline) {
          throw IOException("Weather response exceeds transport bounds")
        }
        result.write(buffer, 0, count)
      }
    }
    return mapOf("status" to status, "body" to result.toString(Charsets.UTF_8.name()))
  } finally {
    connection.disconnect()
  }
}
