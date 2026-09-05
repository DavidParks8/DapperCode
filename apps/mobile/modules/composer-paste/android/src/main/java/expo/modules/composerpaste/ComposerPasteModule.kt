package expo.modules.composerpaste

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.core.view.ViewCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class ComposerPasteModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ComposerPaste")
    View(ComposerPasteView::class) {
      Events("onPasteImage", "onPasteBusy", "onPasteError")
      Prop("enabled") { view: ComposerPasteView, enabled: Boolean -> view.pasteEnabled = enabled }
      Prop("scopeKey") { view: ComposerPasteView, scope: String -> view.scopeKey = scope }
    }
  }
}

class ComposerPasteView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var pasteEnabled = false
  var scopeKey = ""
    set(value) {
      if (field != value) {
        cancel()
      }
      field = value
    }
  private val onPasteImage by EventDispatcher()
  private val onPasteBusy by EventDispatcher()
  private val onPasteError by EventDispatcher()
  private var input: EditText? = null
  private var generation = 0
  private var busy = false

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val next = findInput(this) ?: return
    if (input === next) return
    detachInput()
    input = next
    ViewCompat.setOnReceiveContentListener(next, arrayOf("image/*")) { _, content ->
      val parts = content.partition { item ->
        item.uri?.let { context.contentResolver.getType(it)?.startsWith("image/") } == true
      }
      val images = parts.first
      if (images != null) {
        if (!pasteEnabled || busy) {
          val message = if (busy) "Wait for the current photo paste to finish"
            else "Photo paste is unavailable right now"
          onPasteError(mapOf("message" to message, "scopeKey" to scopeKey))
        } else {
          val uris = (0 until images.clip.itemCount).mapNotNull { images.clip.getItemAt(it).uri }
          paste(uris)
        }
      }
      // Unhandled text keeps Android's normal selection/replacement behavior.
      parts.second
    }
  }

  override fun onDetachedFromWindow() {
    detachInput()
    super.onDetachedFromWindow()
  }

  private fun detachInput() {
    input?.let { ViewCompat.setOnReceiveContentListener(it, null, null) }
    input = null
    cancel()
  }

  private fun cancel() {
    generation += 1
    val wasBusy = busy
    busy = false
    if (wasBusy) onPasteBusy(mapOf("busy" to false, "scopeKey" to scopeKey))
  }

  private fun findInput(view: View): EditText? {
    if (view is EditText) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findInput(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  private fun paste(uris: List<Uri>) {
    val scope = scopeKey
    val owner = generation
    if (uris.size > 8) {
      onPasteError(mapOf("message" to "Paste no more than 8 photos at a time", "scopeKey" to scope))
      return
    }
    busy = true
    onPasteBusy(mapOf("busy" to true, "scopeKey" to scope))
    worker.execute {
      for (uri in uris) {
        var file: File? = null
        try {
          val destination = File(context.cacheDir, "pasted-photo-${UUID.randomUUID()}.img")
          file = destination
          val stream = context.contentResolver.openInputStream(uri) ?: error("Unable to read pasted photo")
          stream.use { source ->
            destination.outputStream().use { output ->
              val buffer = ByteArray(8192)
              var total = 0
              while (true) {
                val count = source.read(buffer)
                if (count < 0) break
                total += count
                check(total <= 20 * 1024 * 1024) { "Photo exceeds the 20 MB limit" }
                output.write(buffer, 0, count)
              }
            }
          }
          val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          BitmapFactory.decodeFile(destination.absolutePath, options)
          check(options.outWidth > 0 && options.outHeight > 0) { "Unable to read pasted photo" }
          mainHandler.post {
            if (generation == owner && scopeKey == scope && input != null) {
              onPasteImage(mapOf("uri" to Uri.fromFile(destination).toString(),
                "fileName" to destination.name, "fileSize" to destination.length(),
                "width" to options.outWidth, "height" to options.outHeight, "scopeKey" to scope))
            } else {
              destination.delete()
            }
          }
        } catch (error: Exception) {
          file?.delete()
          mainHandler.post {
            if (generation == owner && scopeKey == scope && input != null) {
              onPasteError(mapOf("message" to (error.message ?: "Unable to paste photo"), "scopeKey" to scope))
            }
          }
        }
      }
      mainHandler.post {
        if (generation == owner && scopeKey == scope && input != null) {
          busy = false
          onPasteBusy(mapOf("busy" to false, "scopeKey" to scope))
        }
      }
    }
  }

  companion object {
    private val worker = Executors.newSingleThreadExecutor()
    // View.post queues indefinitely after detach; cleanup must not depend on reattachment.
    private val mainHandler = Handler(Looper.getMainLooper())
  }
}
