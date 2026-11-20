package expo.modules.liflowpdfinspection

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

class LiFlowPdfInspectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LiFlowPdfInspection")

    AsyncFunction("pageCount") Coroutine { uri: String ->
      val context = appContext.reactContext?.applicationContext ?: return@Coroutine null
      withContext(Dispatchers.IO) {
        val file = cachedPdf(context, uri) ?: return@withContext 0
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pdf ->
          withTimeoutOrNull(5_000L) {
            withContext(Dispatchers.Main.immediate) { inspect(context, pdf) }
          }
        }
      }
    }
  }

  private fun cachedPdf(context: Context, value: String): File? {
    val uri = Uri.parse(value)
    if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) return null
    val path = uri.path ?: return null
    return try {
      val file = File(path).canonicalFile
      val cache = context.cacheDir.canonicalPath + File.separator
      file.takeIf { it.path.startsWith(cache) && it.isFile && it.length() in 32L..(6L * 1024 * 1024) }
    } catch (_: IOException) {
      null
    }
  }

  private suspend fun inspect(context: Context, pdf: ParcelFileDescriptor): Int? {
    val count = CompletableDeferred<Int?>()
    val reply = Messenger(Handler(Looper.getMainLooper()) { message ->
      count.complete(message.arg1)
      true
    })
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        val request = Message.obtain().apply {
          data = Bundle().apply { putParcelable(PdfPageCountService.PDF_DESCRIPTOR, pdf) }
          replyTo = reply
        }
        try {
          Messenger(binder).send(request)
        } catch (_: RemoteException) {
          count.complete(null)
        }
      }

      override fun onServiceDisconnected(name: ComponentName) { count.complete(null) }
      override fun onBindingDied(name: ComponentName) { count.complete(null) }
      override fun onNullBinding(name: ComponentName) { count.complete(null) }
    }
    val bound = context.bindService(Intent(context, PdfPageCountService::class.java), connection, Context.BIND_AUTO_CREATE)
    try {
      return if (bound) count.await() else null
    } finally {
      context.unbindService(connection)
    }
  }
}
