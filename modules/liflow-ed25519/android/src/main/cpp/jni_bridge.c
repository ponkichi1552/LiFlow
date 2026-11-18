#include <jni.h>
#include <stdint.h>

#include "liflow_ed25519.h"

static const unsigned char *direct_bytes(JNIEnv *env, jobject buffer, jlong *capacity) {
  if (buffer == NULL) {
    *capacity = -1;
    return NULL;
  }

  *capacity = (*env)->GetDirectBufferCapacity(env, buffer);
  if (*capacity < 0) {
    return NULL;
  }

  return (const unsigned char *)(*env)->GetDirectBufferAddress(env, buffer);
}

JNIEXPORT jstring JNICALL
Java_expo_modules_liflowed25519_NativeBridge_version(JNIEnv *env, jobject self) {
  (void)self;
  const char *version = lf_ed25519_version();
  return (*env)->NewStringUTF(env, version == NULL ? "" : version);
}

JNIEXPORT jboolean JNICALL
Java_expo_modules_liflowed25519_NativeBridge_verify(
  JNIEnv *env,
  jobject self,
  jobject signature_buffer,
  jobject message_buffer,
  jobject public_key_buffer
) {
  (void)self;
  jlong signature_capacity = -1;
  jlong message_capacity = -1;
  jlong public_key_capacity = -1;
  const unsigned char *signature = direct_bytes(env, signature_buffer, &signature_capacity);
  const unsigned char *message = direct_bytes(env, message_buffer, &message_capacity);
  const unsigned char *public_key = direct_bytes(env, public_key_buffer, &public_key_capacity);

  if (signature_capacity != 64 || message_capacity < 0 || public_key_capacity != 32 ||
      signature == NULL || public_key == NULL ||
      (message_capacity != 0 && message == NULL)) {
    return JNI_FALSE;
  }

  return lf_ed25519_verify(
    signature,
    (size_t)signature_capacity,
    message,
    (size_t)message_capacity,
    public_key,
    (size_t)public_key_capacity
  ) ? JNI_TRUE : JNI_FALSE;
}
