import ExpoModulesCore
import Foundation
import Security

private let maxForecastBytes = 512 * 1024

public final class LiFlowWeatherTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiFlowWeatherTransport")

    AsyncFunction("get") { (address: String, certificate: String, etag: String?) async throws -> [String: Any] in
      try await fetchWeather(address: address, certificate: certificate, etag: etag)
    }
  }
}

private func fetchWeather(address: String, certificate: String, etag: String?) async throws -> [String: Any] {
  guard let url = URL(string: address), url.scheme == "https", let host = url.host,
        url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
        certificate.utf8.count <= 8_192, let der = Data(base64Encoded: certificate),
        let anchor = SecCertificateCreateWithData(nil, der as CFData),
        etag.map({ $0.range(of: #"^"[a-f0-9]{64}"$"#, options: .regularExpression) != nil }) ?? true else {
    throw URLError(.badURL)
  }

  let settings = URLSessionConfiguration.ephemeral
  settings.timeoutIntervalForRequest = 8
  settings.timeoutIntervalForResource = 14
  settings.httpShouldSetCookies = false
  settings.urlCache = nil
  let delegate = WeatherTrustDelegate(host: host, anchor: anchor)
  let session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
  defer { session.invalidateAndCancel() }

  var request = URLRequest(url: url)
  request.setValue("application/json", forHTTPHeaderField: "Accept")
  request.setValue(etag, forHTTPHeaderField: "If-None-Match")
  let (stream, response) = try await session.bytes(for: request, delegate: delegate)
  guard let http = response as? HTTPURLResponse, response.url == url else { throw URLError(.badServerResponse) }
  guard http.statusCode == 200 else { return ["status": http.statusCode] }
  guard response.expectedContentLength <= maxForecastBytes else { throw URLError(.dataLengthExceedsMaximum) }
  var bytes = Data()
  for try await value in stream {
    guard bytes.count < maxForecastBytes else { throw URLError(.dataLengthExceedsMaximum) }
    bytes.append(value)
  }
  guard let body = String(data: bytes, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
  return ["status": http.statusCode, "body": body]
}

private final class WeatherTrustDelegate: NSObject, URLSessionTaskDelegate {
  private let host: String
  private let anchor: SecCertificate

  init(host: String, anchor: SecCertificate) {
    self.host = host
    self.anchor = anchor
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, space.host.caseInsensitiveCompare(host) == .orderedSame,
          let trust = space.serverTrust,
          SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
          SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
          SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
          SecTrustEvaluateWithError(trust, nil) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
