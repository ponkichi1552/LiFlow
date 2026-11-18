#include "liflow_ed25519.h"

#include <sodium.h>

#if defined(ED25519_COMPAT)
#error "LiFlow must use libsodium's strict Ed25519 verifier"
#endif

const char *lf_ed25519_version(void) {
  if (sodium_init() < 0) {
    return "";
  }
  return sodium_version_string();
}

int lf_ed25519_verify(
  const unsigned char *signature,
  size_t signature_length,
  const unsigned char *message,
  size_t message_length,
  const unsigned char *public_key,
  size_t public_key_length
) {
  static const unsigned char empty_message = 0;

  if (signature == NULL || signature_length != crypto_sign_BYTES ||
      public_key == NULL || public_key_length != crypto_sign_PUBLICKEYBYTES ||
      (message_length != 0 && message == NULL)) {
    return 0;
  }

  if (sodium_init() < 0) {
    return 0;
  }

  if (message == NULL) {
    message = &empty_message;
  }

  return crypto_sign_verify_detached(
    signature,
    message,
    (unsigned long long)message_length,
    public_key
  ) == 0;
}
