// Приложение Task Pilot для Dock: свое окно с интерфейсом вместо вкладки браузера. Запуск поднимает сервер и
// интерфейс (launcher.ts start) и показывает их в окне, клик по иконке возвращает закрытое окно, выход из
// приложения останавливает то, что оно запустило. Экземпляр, запущенный иначе (например pnpm dev в терминале),
// окно только показывает и не останавливает. Ссылки на Jira, Bitbucket, Kibana и стенды открываются в браузере по
// умолчанию, уведомления интерфейса идут в Центр уведомлений macOS.
// Собирается скриптом launcher/install.sh: он подставляет путь к node, путь к launcher.ts и адреса интерфейса.
import Cocoa
import UserNotifications
import WebKit

let nodePath = "__NODE__"
let launcherPath = "__LAUNCHER__"
let uiAddress = "__UI__"
let uiLocalhost = "__UI_LOCALHOST__"

/// Ответ команды launcher.ts: вывод и успех. При ошибке вывод - текст из stderr.
struct LauncherResult {
  let output: String
  let ok: Bool
}

/// Вызывает node launcher.ts с командой (start, stop, status, busy, log) и ждет ответа.
func launcher(_ command: String) -> LauncherResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: nodePath)
  process.arguments = [launcherPath, command]
  let out = Pipe()
  let err = Pipe()
  process.standardOutput = out
  process.standardError = err
  do {
    try process.run()
  } catch {
    return LauncherResult(output: error.localizedDescription, ok: false)
  }
  let stdout = out.fileHandleForReading.readDataToEndOfFile()
  let stderr = err.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let ok = process.terminationStatus == 0
  let text = String(decoding: ok ? stdout : stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  return LauncherResult(output: text, ok: ok)
}

/**
 Выполняет block на главном потоке через цикл событий, а не через главную очередь. Пока приложение ждет ответа на
 завершение, цикл событий крутится внутри обработчика, который мог прийти из главной очереди (SIGTERM), и ее
 следующие задачи ждали бы его конца, а блок цикла событий выполнится.
 */
func onMainLoop(_ block: @escaping () -> Void) {
  CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue, block)
  CFRunLoopWakeUp(CFRunLoopGetMain())
}

/// Строка в кавычках JSON: так значение безопасно вставить в JavaScript.
func jsString(_ value: String) -> String {
  guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
  return text
}

/// Страница ожидания в окне, пока интерфейс не открылся; с retry она раз в 3 секунды пробует открыть его снова.
func waitPage(_ text: String, retry: Bool = false) -> String {
  """
  <!doctype html><meta charset="utf-8">\(retry ? "<meta http-equiv=\"refresh\" content=\"3;url=\(uiAddress)\">" : "")<style>
  html { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; font: 15px -apple-system, system-ui, sans-serif; color: #64748b; }
  </style><body>\(text)</body>
  """
}

/**
 Замена Notification для страницы: WebKit в приложении уведомлений браузера не показывает, поэтому уведомления
 интерфейса уходят в приложение, а оно показывает их в Центре уведомлений macOS. Клик по уведомлению вызывает
 onclick того уведомления, как в браузере. Разрешение приложение передает при загрузке страницы (permission).
 */
func notificationShim(_ permission: String) -> String {
  """
  (() => {
    const bridge = window.webkit.messageHandlers.taskPilot;
    const shown = new Map();
    const state = { permission: \(jsString(permission)), pending: [] };
    state.clicked = (tag) => {
      const n = shown.get(tag);
      if (n && typeof n.onclick === 'function') n.onclick(new Event('click'));
    };
    state.decided = (value) => {
      state.permission = value;
      state.pending.splice(0).forEach((resolve) => resolve(value));
    };
    class TaskPilotNotification {
      constructor(title, options = {}) {
        this.title = title;
        this.body = options.body ?? '';
        this.tag = options.tag ?? String(Date.now());
        this.onclick = null;
        shown.set(this.tag, this);
        bridge.postMessage({ kind: 'notify', title: this.title, body: this.body, tag: this.tag });
      }
      close() {
        shown.delete(this.tag);
        bridge.postMessage({ kind: 'close', tag: this.tag });
      }
      static get permission() {
        return state.permission;
      }
      static requestPermission() {
        return new Promise((resolve) => {
          state.pending.push(resolve);
          bridge.postMessage({ kind: 'permission' });
        });
      }
    }
    window.__taskPilotNotifications = state;
    window.Notification = TaskPilotNotification;
  })();
  """
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  /// Сервер запустило это приложение или его прежняя сборка: выход его останавливает, а падение - сообщение.
  var ownsServer = false
  var watchdog: Timer?
  var stopping = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Окно раньше меню: пункты меню "Вид" адресованы окну с интерфейсом.
    makeWindow()
    NSApp.mainMenu = makeMenu()
    UNUserNotificationCenter.current().delegate = self
    webView.loadHTMLString(waitPage("Запускаю Task Pilot…"), baseURL: nil)
    DispatchQueue.global(qos: .userInitiated).async {
      let result = launcher("start")
      DispatchQueue.main.async { self.started(result) }
    }
  }

  func started(_ result: LauncherResult) {
    guard result.ok else {
      report("Task Pilot не запустился.", result.output)
      NSApp.terminate(nil)
      return
    }
    ownsServer = result.output != "running:external"
    loadUI()
    // Как прежний апплет: сервер, который приложение держит, проверяется раз в 15 секунд.
    if ownsServer { watchdog = Timer.scheduledTimer(timeInterval: 15, target: self, selector: #selector(check), userInfo: nil, repeats: true) }
  }

  /// Открывает интерфейс. Разрешение на уведомления узнается до загрузки: страница читает его сразу при открытии.
  func loadUI() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let permission: String
      switch settings.authorizationStatus {
      case .authorized, .provisional: permission = "granted"
      case .denied: permission = "denied"
      default: permission = "default"
      }
      DispatchQueue.main.async {
        self.setShim(permission)
        if let url = URL(string: uiAddress) { self.webView.load(URLRequest(url: url)) }
      }
    }
  }

  /// Скрипт уведомлений с текущим разрешением: его получит и страница после перезагрузки.
  func setShim(_ permission: String) {
    let content = webView.configuration.userContentController
    content.removeAllUserScripts()
    content.addUserScript(WKUserScript(source: notificationShim(permission), injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  @objc func check() {
    DispatchQueue.global(qos: .utility).async {
      let status = launcher("status")
      DispatchQueue.main.async {
        guard !self.stopping, status.output != "running:ours" else { return }
        self.watchdog?.invalidate()
        self.ownsServer = false
        self.report("Task Pilot остановился.", "")
        NSApp.terminate(nil)
      }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  // Закрытое окно не завершает приложение: Task Pilot продолжает работать, окно вернет клик по иконке.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard ownsServer, !stopping else { return .terminateNow }
    // Если выполняются прогоны, приложение сначала спрашивает: остановка прервет их шаги.
    if launcher("status").output == "running:ours", let busy = Int(launcher("busy").output), busy > 0 {
      let alert = NSAlert()
      alert.messageText = "Выполняется прогонов: \(busy)"
      alert.informativeText = "Если остановить Task Pilot, их шаги прервутся."
      alert.alertStyle = .warning
      alert.addButton(withTitle: "Не останавливать")
      alert.addButton(withTitle: "Остановить")
      if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel }
    }
    stopping = true
    watchdog?.invalidate()
    webView.loadHTMLString(waitPage("Останавливаю Task Pilot…"), baseURL: nil)
    DispatchQueue.global(qos: .userInitiated).async {
      _ = launcher("stop")
      onMainLoop { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  /// Сообщение о сбое с кнопкой, открывающей журнал запуска.
  func report(_ headline: String, _ details: String) {
    let alert = NSAlert()
    alert.messageText = headline
    alert.informativeText = details
    alert.alertStyle = .critical
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Открыть журнал")
    if alert.runModal() == .alertSecondButtonReturn { _ = launcher("log") }
  }

  @objc func showWindow() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func openLog() {
    DispatchQueue.global(qos: .utility).async {
      let result = launcher("log")
      if !result.ok { DispatchQueue.main.async { self.report("Журнал не открылся.", result.output) } }
    }
  }

  @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
  @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
  @objc func zoomReset() { webView.pageZoom = 1 }

  func makeWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.userContentController.add(self, name: "taskPilot")
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    // Страницу можно открыть в Web Inspector Safari: меню "Разработка".
    if #available(macOS 13.3, *) { webView.isInspectable = true }
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Task Pilot"
    window.contentView = webView
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 800, height: 500)
    window.center()
    // Размер и место окна сохраняются между запусками.
    window.setFrameAutosaveName("TaskPilotWindow")
    showWindow()
  }

  func isOurs(_ url: URL) -> Bool {
    let text = url.absoluteString
    return text.hasPrefix(uiAddress) || text.hasPrefix(uiLocalhost) || url.scheme == "about" || url.scheme == "data"
  }

  // Внутри окна открывается только интерфейс Task Pilot, остальное - в браузере по умолчанию.
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url, !isOurs(url) else { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  // Ссылки target="_blank": Jira, Bitbucket, Kibana, стенды и снимки из галереи - в браузере по умолчанию.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    guard !stopping else { return }
    // Например, идет pnpm restart: страница ожидания сама откроет интерфейс, когда он ответит.
    webView.loadHTMLString(waitPage("Интерфейс Task Pilot не отвечает, пробую снова: \(error.localizedDescription)", retry: true), baseURL: nil)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Отмена")
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
  }

  // Сообщения замены Notification со страницы: разрешение, показ и снятие уведомления.
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    let center = UNUserNotificationCenter.current()
    switch kind {
    case "permission":
      center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        DispatchQueue.main.async {
          let value = granted ? "granted" : "denied"
          self.setShim(value)
          self.webView.evaluateJavaScript("window.__taskPilotNotifications?.decided(\(jsString(value)))")
        }
      }
    case "notify":
      let content = UNMutableNotificationContent()
      content.title = body["title"] as? String ?? "Task Pilot"
      content.body = body["body"] as? String ?? ""
      content.sound = .default
      let tag = body["tag"] as? String ?? UUID().uuidString
      content.userInfo = ["tag": tag]
      center.add(UNNotificationRequest(identifier: tag, content: content, trigger: nil))
    case "close":
      if let tag = body["tag"] as? String { center.removeDeliveredNotifications(withIdentifiers: [tag]) }
    default:
      break
    }
  }

  // Клик по уведомлению: окно выходит вперед, а страница открывает прогон или дашборд из уведомления.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    let tag = response.notification.request.content.userInfo["tag"] as? String ?? ""
    DispatchQueue.main.async {
      self.showWindow()
      self.webView.evaluateJavaScript("window.__taskPilotNotifications?.clicked(\(jsString(tag)))")
    }
    completionHandler()
  }

  // Уведомление показывается и при открытом окне: когда уведомлять, решает сама страница.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound])
  }

  func makeMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let holder = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      holder.submenu = menu
      main.addItem(holder)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mask: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mask
      i.target = target
      return i
    }
    _ = submenu("Task Pilot", [
      item("О Task Pilot", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Журнал запуска", #selector(openLog), target: self),
      .separator(),
      item("Скрыть Task Pilot", #selector(NSApplication.hide(_:)), "h"),
      item("Скрыть остальные", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Показать все", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Завершить Task Pilot", #selector(NSApplication.terminate(_:)), "q"),
    ])
    // Без меню "Правка" в полях ввода не работают Cmd+C, Cmd+V и остальные сочетания.
    _ = submenu("Правка", [
      item("Отменить", Selector(("undo:")), "z"),
      item("Повторить", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Вырезать", #selector(NSText.cut(_:)), "x"),
      item("Скопировать", #selector(NSText.copy(_:)), "c"),
      item("Вставить", #selector(NSText.paste(_:)), "v"),
      item("Выбрать все", #selector(NSText.selectAll(_:)), "a"),
    ])
    _ = submenu("Вид", [
      item("Обновить", #selector(WKWebView.reload(_:)), "r", target: webView),
      item("Назад", #selector(WKWebView.goBack(_:)), "[", target: webView),
      item("Вперед", #selector(WKWebView.goForward(_:)), "]", target: webView),
      .separator(),
      item("Увеличить", #selector(zoomIn), "=", target: self),
      item("Уменьшить", #selector(zoomOut), "-", target: self),
      item("Фактический размер", #selector(zoomReset), "0", target: self),
    ])
    let windows = submenu("Окно", [
      item("Свернуть", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Изменить масштаб", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("Task Pilot", #selector(showWindow), "1", target: self),
    ])
    NSApp.windowsMenu = windows
    return main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
// SIGTERM (kill, pkill) завершает приложение как Cmd+Q: с вопросом о прогонах и остановкой Task Pilot.
signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { onMainLoop { NSApp.terminate(nil) } }
terminate.resume()
app.run()
