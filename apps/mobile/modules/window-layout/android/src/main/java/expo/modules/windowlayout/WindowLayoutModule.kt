package expo.modules.windowlayout

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class WindowLayoutModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WindowLayout")
    View(WindowLayoutObserverView::class) {
      Events("onWindowLayoutChange")
    }
  }
}

/**
 * A full-window, non-interactive view that reports the folds currently splitting the window, in
 * the same shape as the iOS observer. Android has no size classes, so it reports them as
 * unspecified and JavaScript keeps its width breakpoint.
 */
class WindowLayoutObserverView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  private val onWindowLayoutChange by EventDispatcher()
  private var tracker: WindowInfoTrackerCallbackAdapter? = null
  private var features: List<DisplayFeature> = emptyList()
  private var lastPayload: Map<String, Any>? = null
  private val listener = Consumer<WindowLayoutInfo> { info ->
    features = info.displayFeatures
    publish()
  }

  init {
    isClickable = false
    isFocusable = false
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val activity = appContext.currentActivity ?: return
    val adapter = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity))
    adapter.addWindowLayoutInfoListener(activity, ContextCompat.getMainExecutor(context), listener)
    tracker = adapter
  }

  override fun onDetachedFromWindow() {
    tracker?.removeWindowLayoutInfoListener(listener)
    tracker = null
    lastPayload = null
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    publish()
  }

  private fun publish() {
    if (!isAttachedToWindow) return
    val origin = IntArray(2).also { getLocationInWindow(it) }
    val density = resources.displayMetrics.density.toDouble()
    // A fold only divides the window while it is half open (or is a physical hinge gap).
    val divisions = features.filterIsInstance<FoldingFeature>().filter { it.isSeparating }.map {
      val bounds = it.bounds
      mapOf(
        "x" to (bounds.left - origin[0]) / density,
        "y" to (bounds.top - origin[1]) / density,
        "width" to bounds.width() / density,
        "height" to bounds.height() / density,
      )
    }
    val payload = mapOf(
      "horizontalSizeClass" to "unspecified",
      "verticalSizeClass" to "unspecified",
      "verticalBarEdge" to "unspecified",
      "divisions" to divisions,
      "occlusions" to emptyList<Map<String, Double>>(),
    )
    if (payload == lastPayload) return
    lastPayload = payload
    onWindowLayoutChange(payload)
  }
}
