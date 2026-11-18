#ifndef LIFLOW_ED25519_H
#define LIFLOW_ED25519_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

const char *lf_ed25519_version(void);

int lf_ed25519_verify(
  const unsigned char *signature,
  size_t signature_length,
  const unsigned char *message,
  size_t message_length,
  const unsigned char *public_key,
  size_t public_key_length
);

#ifdef __cplusplus
}
#endif

#endif
