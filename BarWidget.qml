import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Timer.js" as TimerLib

// abobreshov.pomodoro — the bar pill, one per monitor.
//
// Renders the timer that Service.qml owns (bar.shell.serviceFor) and hosts
// the popup (Panel.qml). Horizontal bars keep upstream's pill: stopwatch
// glyph (coffee during breaks) plus the remaining time in a phase-tinted
// pill, dimmed while idle; middle click starts or pauses, left click opens
// the popup. Vertical bars show the glyph alone, one icon slot high, with
// the time in the tooltip.
BarWidget {
  id: root
  moduleName: TimerLib.TARGET

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor(TimerLib.TARGET) : null
  readonly property var view: service ? service.view : TimerLib.idleView()
  readonly property var cfg: service ? service.cfg : TimerLib.settings({})

  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color breakColor: root.cfg.breakColor

  // Phase theming (upstream): work uses the theme accent, breaks a distinct
  // green; idle stays neutral and dimmed.
  readonly property color phaseColor: root.view.isBreak ? root.breakColor : Color.accent
  readonly property color pillTextColor: root.view.playing ? root.phaseColor : root.contentForeground
  readonly property color pillBackground: {
    if (!root.view.hasSession) return Qt.rgba(0, 0, 0, 0)
    if (root.view.playing) return Util.alpha(root.phaseColor, 0.18)
    return Util.alpha(root.contentForeground, 0.10)
  }
  readonly property var layout: TimerLib.pillLayout(root.vertical, {
    barSize: root.barSize, iconSlot: Style.bar.iconSlot, pillWidth: Style.space(56)
  }, root.view)

  implicitWidth: root.layout.width
  implicitHeight: root.layout.height
  opacity: root.layout.opacity

  // The bar shows a tooltip only for a target that reports `tooltipHovered`
  // (Bar.targetTooltipHovered, as the kit's Tray items and WidgetButton do);
  // without it showTooltip returned before showing anything. The text is the
  // one handed over on enter and stays put while hovered: showing it again
  // on every tick would hide and reopen it each second.
  readonly property bool tooltipHovered: visible && opacity > 0 && pillMouse.containsMouse

  // ---- Service binding: register for the open/close relays and hand the
  //      service to the popup. Settings reach the service through the
  //      shell's bar config, not through this widget.
  function bindService() {
    if (!root.service) return
    root.service.registerWidget(root)
  }

  onServiceChanged: {
    root.bindService()
    root.injectPanel()
  }
  onSettingsChanged: root.injectPanel()
  onBarChanged: root.injectPanel()
  Component.onDestruction: if (root.service) root.service.unregisterWidget(root)

  function toggleTimer() { if (root.service) root.service.toggleTimer() }

  // ---- Popup. Shape contract for shell.summon/hide/toggle routing and the
  //      service's relay: open/close/togglePanel/opened on the widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = barItem
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.service
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // ---- Pill (upstream layout; vertical form is glyph-only).
  Item {
    id: barItem
    anchors.fill: parent

    Rectangle {
      anchors.fill: parent
      anchors.margins: Style.space(2)
      radius: Math.round(height / 2)
      color: root.pillBackground

      Behavior on color {
        ColorAnimation { duration: 200; easing.type: Easing.OutCubic }
      }
    }

    Row {
      anchors.centerIn: parent
      spacing: Style.space(4)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.view.phaseGlyph
        textFormat: Text.PlainText
        color: root.pillTextColor
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.icon
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.layout.showTime
        text: root.view.timeText
        textFormat: Text.PlainText
        color: root.pillTextColor
        opacity: root.view.hasSession ? 1.0 : 0.55
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }

    MouseArea {
      id: pillMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.MiddleButton

      onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton) root.toggleTimer()
        else root.togglePanel()
      }

      onEntered: if (root.bar) root.bar.showTooltip(root, root.view.tooltip)
      onExited: if (root.bar) root.bar.hideTooltip(root)
    }
  }
}
