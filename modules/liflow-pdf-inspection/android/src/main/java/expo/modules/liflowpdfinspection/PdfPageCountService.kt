package expo.modules.liflowpdfinspection

import android.app.Service
import android.content.Intent
import android.graphics.pdf.PdfRenderer
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import java.io.IOException

class PdfPageCountService : Service() {
  private val worker = HandlerThread("LiFlowPdfInspection")
  private lateinit var incoming: Messenger

  override fun onCreate() {
    super.onCreate()
    worker.start()
    incoming = Messenger(Handler(worker.looper, ::inspect))
  }

  override fun onBind(intent: Intent): IBinder = incoming.binder

  override fun onDestroy() {
    worker.quitSafely()
    super.onDestroy()
  }

  private fun inspect(request: Message): Boolean {
    @Suppress("DEPRECATION")
    val descriptor = request.data.getParcelable<ParcelFileDescriptor>(PDF_DESCRIPTOR)
    val count = if (descriptor == null) 0 else pageCount(descriptor)
    try {
      request.replyTo?.send(Message.obtain().apply { arg1 = count })
    } catch (_: RemoteException) {
      // The UI left or the inspection timed out.
    }
    return true
  }

  private fun pageCount(descriptor: ParcelFileDescriptor): Int = try {
    // PdfRenderer owns the FD after construction. The outer close also covers constructor failure.
    descriptor.use { fd -> PdfRenderer(fd).use { it.pageCount } }
  } catch (_: SecurityException) {
    0
  } catch (_: IOException) {
    0
  }

  companion object {
    internal const val PDF_DESCRIPTOR = "pdf"
  }
}
