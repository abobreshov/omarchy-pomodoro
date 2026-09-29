pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "Timer.js" as TimerLib

// abobreshov.pomodoro — the popup controller, hosted by BarWidget.qml.
//
// Upstream's popup: phase label with pomodoro count dots, a large remaining
// time readout, a progress bar, transport buttons and the key hint. The fork
// adds one task line (only while a task is attached), two captions and `x`
// to detach. Keyboard: Space start/pause, R reset (back to idle, no task),
// S skip, X detach, Tab switches panels, Esc closes. Every action goes to
// the service.
Panel {
  id: root
  moduleName: TimerLib.TARGET
  ipcTarget: TimerLib.TARGET
  manageIpc: false   // Service.qml owns the single IpcHandler for this target

  property var anchorItem: null

  // The bar identifies the popup by the widget mounted in its slot, not by
  // this nested panel (popout coordinator, panel switching).
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // The hosting widget hands the service over (the shell's own panel idiom).
  property var service: null
  readonly property var view: service ? service.view : TimerLib.idleView()
  readonly property var cfg: service ? service.cfg : TimerLib.settings({})

  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property color dimForeground: Qt.darker(root.contentForeground, 1.5)
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color breakColor: root.cfg.breakColor
  readonly property color phaseColor: root.view.isBreak ? root.breakColor : Color.accent

  readonly property string playIcon: root.view.playing ? "\uf04c" : "\uf04b" // fa-pause / fa-play
  readonly property string playTooltip: {
    if (root.view.playing) return "Pause (Space)"
    return root.view.hasSession ? "Start (Space)" : "Start pomodoro (Space)"
  }

  function toggleTimer() { if (root.service) root.service.toggleTimer() }
  function resetPhase() { if (root.service) root.service.resetPhase() }
  function skipPhase() { if (root.service) root.service.skipPhase() }
  function detachTask() { if (root.service) root.service.detachTask() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight + Style.space(24))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onActivateRequested: root.toggleTimer()
      onCloseRequested: root.close()
      onDeleteRequested: root.detachTask()

      onTabRequested: function(direction) {
        root.switchPanel(direction)
      }

      onTextKey: function(t) {
        if (t === "r") root.resetPhase()
        else if (t === "s") root.skipPhase()
      }

      Column {
        id: contentColumn
        width: parent.width - Style.space(24)
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: Style.space(12)

        // ------------------------------------------------- phase + count

        RowLayout {
          width: parent.width
          spacing: Style.space(6)

          Text {
            Layout.alignment: Qt.AlignVCenter
            text: root.view.phaseGlyph
            textFormat: Text.PlainText
            color: root.view.playing ? root.phaseColor : root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            Layout.alignment: Qt.AlignVCenter
            text: root.view.phaseLabel
            textFormat: Text.PlainText
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Item { Layout.fillWidth: true }

          Repeater {
            model: root.view.perCycle

            Rectangle {
              required property int index
              width: Style.space(6)
              height: Style.space(6)
              radius: Math.round(width / 2)
              color: index < root.view.completed
                  ? Color.accent
                  : Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.25)
            }
          }
        }

        // ------------------------------------------------------ task line

        RowLayout {
          width: parent.width
          spacing: Style.space(6)
          visible: root.view.attached

          Text {
            Layout.alignment: Qt.AlignVCenter
            text: "󰓾" // md-target (outside the BMP: written raw, as upstream writes the coffee glyph)
            textFormat: Text.PlainText
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
            text: root.view.taskLabel
            textFormat: Text.PlainText
            elide: Text.ElideRight
            maximumLineCount: 1
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          PanelActionButton {
            Layout.alignment: Qt.AlignVCenter
            iconText: "󰅖" // md-close
            tooltipText: "Detach task (x)"
            size: Style.space(24)
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.detachTask()
          }
        }

        // ------------------------------------------------------- captions

        Text {
          width: parent.width
          visible: root.view.recordCaption !== ""
          text: root.view.recordCaption
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: Color.urgent
          opacity: 0.8
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          width: parent.width
          visible: root.view.restored
          text: root.view.restoredCaption
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.dimForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }

        // -------------------------------------------------- remaining time

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.view.remainingText
          textFormat: Text.PlainText
          color: root.contentForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.displayLarge
          font.bold: true
        }

        // ---------------------------------------------------- progress bar

        Rectangle {
          width: parent.width
          height: 5
          radius: Math.round(height / 2)
          color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

          Rectangle {
            width: parent.width * root.view.progress
            height: parent.height
            radius: parent.radius
            color: root.view.playing ? root.phaseColor : root.contentForeground

            Behavior on width {
              NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
            }
          }
        }

        // ------------------------------------------------------ transport

        RowLayout {
          width: parent.width
          spacing: Style.space(16)

          Item { Layout.fillWidth: true }

          PanelActionButton {
            iconText: "\uf051" // fa-step-forward
            tooltipText: "Skip phase (S)"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: root.view.hasSession
            opacity: root.view.hasSession ? 1.0 : 0.7
            onClicked: root.skipPhase()
          }

          PanelActionButton {
            iconText: root.playIcon
            tooltipText: root.playTooltip
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.iconLarge
            onClicked: root.toggleTimer()
          }

          PanelActionButton {
            iconText: "\uf0e2" // fa-undo
            tooltipText: "Reset to idle (R)"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: root.view.hasSession
            opacity: root.view.hasSession ? 1.0 : 0.7
            onClicked: root.resetPhase()
          }

          Item { Layout.fillWidth: true }
        }

        // ------------------------------------------------------- shortcuts

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.view.hint
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.contentForeground
          opacity: 0.45
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
